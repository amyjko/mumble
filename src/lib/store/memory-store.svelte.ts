import {
	DEFAULT_BORDER_WIDTH,
	envelopeSchema,
	mutationSchema,
	parseJson,
	roomStateSchema
} from '$lib/model/schemas';
import { StoreRejection, nowIso, omitKey } from '$lib/model/types';
import type {
	CanvasObject,
	ConfigSnapshot,
	Pose,
	EphemeralMessage,
	Mutation,
	Participant,
	Placer,
	Size,
	RoomState
} from '$lib/model/types';
import { untrack } from 'svelte';
import { canEdit } from '$lib/model/permissions';
import { ellipsePoints, nearestLegal, placementLegal } from '$lib/canvas/geometry';
import { locationKey } from '$lib/model/placement';
import { AVATAR_BORDER } from '$lib/model/avatar';
import { applyEncodedUpdate, docFromEncoded, encodeDoc, mergeEncoded, noteText } from '$lib/model/ydoc';
import {
	admits,
	applyCapacity,
	freshStage,
	grantSlot,
	lowerHand,
	mutedAudio,
	participantLeft,
	raiseHand,
	releaseSlot,
	revokeSlot,
	takeSlot,
	unmutedAudio,
	type StageState
} from '$lib/model/stage';
import type { Clip, Point, SolverShape } from '$lib/model/types';
import type { RoomStore } from './room-store';

function freshState(): RoomState {
	return { objects: {}, participants: {}, background: '', title: '', description: '', create_permission: 'all', border_default: DEFAULT_BORDER_WIDTH, ...freshStage(), transport: 'p2p', participant_locations: {}, placers: [], configurations: {}, active_config: null };
}

/**
 * Stub-only cap on a chat object's retained log (see post_message). Exported so
 * the UI can say so rather than dropping messages silently.
 */
export const CHAT_LOG_LIMIT = 500;

// Defined in the model (model/avatar.ts); re-exported so the many canvas
// imports do not all have to move at once.
export { AVATAR_SIZE, AVATAR_BORDER } from '$lib/model/avatar';

/**
 * The stub backend. It deliberately models the seams the real backend will
 * have (AR-SYNC-2, UX-PERM-4, AR-CANVAS-5's commit-side pass) instead of
 * faking them away:
 *  - commits are async, with injectable latency and forced rejection (DevPanel)
 *  - every commit runs the permission gate and the SAME overlap solver the
 *    client ran during drag
 *  - cross-tab sync via BroadcastChannel: full-snapshot-on-commit for
 *    convergence; inbound messages are zod-parsed and dropped (never thrown)
 *    when malformed or from a stale-tab protocol version
 *  - state persists to localStorage per room (UX-OBJ-10's stub form)
 *
 * Documented limitation: no central authority. Two tabs committing in the
 * same instant can each accept locally and last-writer-wins on the snapshot;
 * real arbitration arrives with the Supabase store.
 */
export class MemoryRoomStore implements RoomStore {
	state = $state<RoomState>(freshState());

	/**
	 * How many chat messages this stub has evicted (see CHAT_LOG_LIMIT). Surfaced
	 * so truncation is visible; always 0 with a real backend.
	 */
	droppedChatMessages = $state(0);

	/** DevPanel knobs. */
	latencyMs = $state(0);
	rejectNext = $state(false);

	private readonly channel: BroadcastChannel | null;
	private closed = false;
	private readonly storageKey: string;
	private readonly actorId: string;
	// Subscription plumbing, never rendered. Making it reactive (SvelteSet)
	// crashes with state_unsafe_mutation: SyncClient subscribes during its own
	// $derived construction, which would then mutate another derived's state.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- see above
	private readonly handlers = new Set<(m: EphemeralMessage) => void>();

	constructor(room: string, actorId: string) {
		this.actorId = actorId;
		this.storageKey = `mumble:room:${room}`;
		this.state = this.hydrate();
		this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`mumble:${room}`);
		if (this.channel) {
			this.channel.onmessage = (event: MessageEvent) => {
				// The boundary: event.data is any — launder to unknown, then parse.
				const data: unknown = event.data;
				const parsed = envelopeSchema.safeParse(data);
				if (!parsed.success) {
					console.warn('mumble: dropped malformed/stale cross-tab message');
					return;
				}
				const envelope = parsed.data;
				switch (envelope.t) {
					case 'state':
						this.state = this.mergeIncoming(envelope.state);
						break;
					case 'ephemeral':
						for (const handler of this.handlers) handler(envelope.message);
						break;
					case 'hello':
						this.broadcastState();
						break;
				}
			};
			this.channel.postMessage({ v: 1, t: 'hello' });
		}
	}

	/**
	 * Reconcile an inbound room snapshot with local state.
	 *
	 * Everything except note text is last-writer-wins on the snapshot, which is
	 * the documented limitation of a store with no central authority. Note
	 * DOCUMENTS are different: replacing them wholesale would discard whatever
	 * this tab typed since the sender's snapshot was taken, which is exactly
	 * the data loss the CRDT exists to prevent. So the two states are merged,
	 * and the merge is order-independent — both tabs converge on the same text
	 * regardless of which snapshot arrives last.
	 */
	private mergeIncoming(incoming: RoomState): RoomState {
		for (const [id, object] of Object.entries(incoming.objects)) {
			if (object.type !== 'note') continue;
			const mine = this.state.objects[id];
			if (mine === undefined || mine.type !== 'note') continue;
			const merged = mergeEncoded(mine.payload.doc, object.payload.doc);
			object.payload = { doc: merged, text: noteText(docFromEncoded(merged)) };
		}
		return incoming;
	}

	private hydrate(): RoomState {
		if (typeof localStorage === 'undefined') return freshState();
		const raw = localStorage.getItem(this.storageKey);
		if (raw === null) return freshState();
		const parsed = roomStateSchema.safeParse(parseJson(raw));
		if (!parsed.success) {
			console.warn('mumble: stored room state failed validation; starting fresh');
			return freshState();
		}
		return parsed.data;
	}

	private persistAndBroadcast(): void {
		// $state.snapshot: plain data out of the reactive proxy — required for
		// structured clone (postMessage) and honest for JSON.
		const snapshot = $state.snapshot(this.state);
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(this.storageKey, JSON.stringify(snapshot));
		}
		this.channel?.postMessage({ v: 1, t: 'state', state: snapshot });
	}

	private broadcastState(): void {
		if (this.closed) return;
		this.channel?.postMessage({ v: 1, t: 'state', state: $state.snapshot(this.state) });
	}

	/**
	 * The stage slice, lifted out of room state and put back. Every stage case
	 * below is then ONE call into the pure module — which is what AR-TEST-4
	 * means by the capacity/queue rules staying extractable.
	 */
	private stage(): StageState {
		return {
			capacity: this.state.capacity,
			video_holders: this.state.video_holders,
			audio_holders: this.state.audio_holders,
			queue: this.state.queue
		};
	}

	private applyStage(next: StageState): void {
		this.state.capacity = next.capacity;
		this.state.video_holders = next.video_holders;
		this.state.audio_holders = next.audio_holders;
		this.state.queue = next.queue;
	}

	/** Solver view of current occupancy (objects + avatars), minus exclusions. */
	private shapes(excludeId?: string): SolverShape[] {
		const out: SolverShape[] = [];
		for (const object of Object.values(this.state.objects)) {
			if (object.id === excludeId) continue;
			if (!participatesInCollision(object)) continue;
			// A hidden object holds no space (UX-ROOM-3): an obstacle nobody can
			// see is worse than an overlap. This has to match the client's
			// `occupying` list exactly — one rule, two enforcement points.
			if (object.hidden) continue;
			out.push(shapeOfObject(object));
		}
		for (const participant of Object.values(this.state.participants)) {
			if (participant.id === excludeId) continue;
			out.push(shapeOfParticipant(participant));
		}
		return out;
	}

	async commit(mutation: Mutation): Promise<void> {
		// Defense in depth: the seam validates its own vocabulary.
		const parsed = mutationSchema.safeParse(mutation);
		if (!parsed.success) throw new StoreRejection('invalid', 'Malformed mutation');

		// untrack: with zero latency this runs synchronously inside whatever
		// effect triggered the commit, and apply() both READS state (collision
		// and permission checks) and WRITES it — which would make the caller's
		// effect depend on the very state it mutates: an infinite loop. A store
		// mutation's internal reads are never a legitimate reactive dependency
		// of its caller, so the seam guarantees it here, for every store
		// implementation and every caller.
		const latency = untrack(() => {
			if (this.rejectNext) {
				this.rejectNext = false;
				throw new StoreRejection('forced', 'Rejected by dev panel');
			}
			return this.latencyMs;
		});
		if (latency > 0) await sleep(latency);
		untrack(() => {
			this.apply(parsed.data);
			this.persistAndBroadcast();
		});
	}

	/** The commit-side gate: permissions (UX-PERM) + overlap (AR-CANVAS-5). */
	private apply(m: Mutation): void {
		switch (m.kind) {
			case 'create_object': {
				// UX-OBJ-9: creation is gated by a ROOM setting, before anything
				// else — placement should not be computed for a create that is
				// about to be refused.
				this.requireMayCreate();
				// Exempt objects land exactly where they were made. Relocating a
				// just-finished stroke off the ink the user drew was the most
				// visible symptom of drawings taking part in collision.
				const spot = participatesInCollision(m.object)
					? nearestLegal(shapeOfObject(m.object), this.shapes(m.object.id))
					: { x: m.object.transform.x, y: m.object.transform.y };
				const object: CanvasObject = {
					...m.object,
					transform: { ...m.object.transform, x: spot.x, y: spot.y }
				};
				this.state.objects[object.id] = object;
				break;
			}
			case 'move_object': {
				const existing = this.requireObject(m.id);
				this.requireEditable(existing);
				const moved = { ...shapeOfObject(existing), x: m.transform.x, y: m.transform.y, width: m.transform.width, height: m.transform.height };
				if (participatesInCollision(existing) && !placementLegal(moved, this.shapes(m.id))) {
					throw new StoreRejection('overlap', 'That placement overlaps content');
				}
				existing.transform = m.transform;
				existing.updated_at = nowIso();
				break;
			}
			case 'edit_note': {
				const existing = this.requireObject(m.id);
				// Permission is checked ONCE per edit, at the mutation boundary.
				// See the note on session-scoped gating in the class doc.
				this.requireEditable(existing);
				// The union now has >1 member, so the type guard is mandatory — the
				// norms re-imposing the check at compile time, exactly as predicted.
				if (existing.type !== 'note') throw new StoreRejection('invalid', 'Not a note');
				// MERGE the update into the note's document rather than replacing
				// its text: that is the entire point of the CRDT (AR-SYNC-4).
				const doc = docFromEncoded(existing.payload.doc);
				if (!applyEncodedUpdate(doc, m.update)) {
					throw new StoreRejection('invalid', 'Malformed note update');
				}
				existing.payload = { doc: encodeDoc(doc), text: noteText(doc) };
				existing.updated_at = nowIso();
				break;
			}
			case 'edit_timer': {
				const existing = this.requireObject(m.id);
				this.requireEditable(existing);
				if (existing.type !== 'timer') throw new StoreRejection('invalid', 'Not a timer');
				existing.payload = m.payload;
				existing.updated_at = nowIso();
				break;
			}
			case 'post_message': {
				// Posting is open participation, NOT layout editing — anyone present
				// may add to a chat, regardless of the object's edit permission
				// (moving/deleting the chat object still obeys permission). Same
				// spirit as self-initiated emotes (UX-AV-7).
				const existing = this.requireObject(m.id);
				if (existing.type !== 'chat') throw new StoreRejection('invalid', 'Not a chat');
				// STUB-ONLY RETENTION BOUND. UX-OBJ-3 says messages are retained,
				// full stop. This caps the log because the whole room lives in
				// localStorage, which is finite — a constraint of the stub, NOT of
				// the requirement. The real backend must not inherit this: it has
				// no such limit, and silently dropping a user's history there
				// would be a genuine bug rather than a storage concession.
				// Recorded as a known deviation in DESIGN.md.
				const withNew = [...existing.payload.messages, m.message];
				existing.payload.messages = withNew.slice(-CHAT_LOG_LIMIT);
				this.droppedChatMessages += withNew.length - existing.payload.messages.length;
				existing.updated_at = nowIso();
				break;
			}
			case 'set_border': {
				const existing = this.requireObject(m.id);
				// "subject to edit permission" (UX-OBJ-8), so this is the editable
				// gate rather than the creator-only one that guards permission.
				this.requireEditable(existing);
				// Narrowing a border widens the object's CONTENT, because the
				// border width is the overlap tolerance (UX-OBJ-12) — so the new
				// size has to be revalidated exactly like a move.
				const widened = { ...shapeOfObject(existing), border: m.width };
				if (participatesInCollision(existing) && !placementLegal(widened, this.shapes(m.id))) {
					throw new StoreRejection('overlap', 'A thinner border would overlap neighbouring content');
				}
				existing.border = { width: m.width };
				existing.updated_at = nowIso();
				break;
			}
			case 'set_room_border': {
				this.requireHostForRoom();
				this.state.border_default = m.width;
				break;
			}
			case 'set_permission': {
				const existing = this.requireObject(m.id);
				// Creator-only, NOT requireEditable: with permission 'all' anyone
				// can edit an object, and letting them also re-lock it would let a
				// passer-by take it from its creator.
				if (existing.creator_id !== this.actorId) {
					throw new StoreRejection('permission', 'Only the creator can change who may edit this');
				}
				existing.permission = m.permission;
				existing.updated_at = nowIso();
				break;
			}
			case 'set_room_create_permission': {
				this.requireHostForRoom();
				this.state.create_permission = m.value;
				break;
			}
			case 'set_hidden': {
				const existing = this.requireObject(m.id);
				this.requireEditable(existing);
				// Unhiding must land somewhere legal: while hidden the object is
				// excluded from occupancy, so the space it used to hold may have
				// been taken. Same primitive arrivals use (AR-CTRL-4).
				if (!m.hidden) {
					const spot = nearestLegal(
						{ ...shapeOfObject(existing), x: existing.transform.x, y: existing.transform.y },
						this.shapes(m.id)
					);
					existing.transform = { ...existing.transform, x: spot.x, y: spot.y };
				}
				existing.hidden = m.hidden;
				existing.updated_at = nowIso();
				break;
			}
			case 'delete_object': {
				const existing = this.requireObject(m.id);
				this.requireEditable(existing);
				this.state.objects = omitKey(this.state.objects, m.id);
				break;
			}
			case 'upsert_participant': {
				// UX-STAGE-11: admission is refused once the room is full. Someone
				// already present is never turned away for being present.
				const present = Object.keys(this.state.participants).length;
				const already = this.state.participants[m.participant.id] !== undefined;
				if (!admits(this.stage(), present, already)) {
					throw new StoreRejection('permission', 'This room is full');
				}
				const located: Participant = { ...m.participant, ...this.entryPlacement(m.participant) };
				this.state.participants[located.id] = located;
				break;
			}
			case 'move_participant': {
				const existing = this.requireParticipant(m.id);
				const moved = { ...shapeOfParticipant(existing), x: m.location.x, y: m.location.y };
				if (!placementLegal(moved, this.shapes(m.id))) {
					throw new StoreRejection('overlap', 'That placement overlaps content');
				}
				existing.location = m.location;
				// AR-CTRL-6: remembered placement is written on drop, keyed per
				// configuration, so it can be read back on entry and on switch.
				this.state.participant_locations[this.locationKey(m.id)] = { ...m.location };
				break;
			}
			case 'remove_participant': {
				this.state.participants = omitKey(this.state.participants, m.id);
				// Leaving releases both slots and drops you from the queue
				// (UX-STAGE-4) — a queue holding absent people hands slots to
				// nobody.
				this.applyStage(participantLeft(this.stage(), m.id));
				break;
			}
			case 'size_participant': {
				// Resize/rotate an avatar (UX-AV-1). Revalidated against the same
				// solver as a move: growing an avatar into a neighbor is exactly as
				// illegal as dragging it there, and only the store sees both.
				const existing = this.requireParticipant(m.id);
				this.requireSelf(m.id, 'You can only resize your own avatar');
				const sized = {
					...shapeOfParticipant(existing),
					x: m.location.x,
					y: m.location.y,
					width: m.size.width,
					height: m.size.height
				};
				if (!placementLegal(sized, this.shapes(m.id))) {
					throw new StoreRejection('overlap', 'That placement overlaps content');
				}
				existing.location = m.location;
				existing.size = m.size;
				existing.rotation = m.rotation;
				break;
			}
			case 'set_participant_clip': {
				const existing = this.requireParticipant(m.id);
				this.requireSelf(m.id, 'You can only reshape your own avatar');
				existing.clip = m.clip;
				break;
			}
			case 'set_hand': {
				// UX-AV-6: raising a hand IS entering the slot queue. It is no
				// longer a stored flag, so there is nothing to keep in sync.
				this.requireSelf(m.id, 'You can only raise your own hand');
				this.requireParticipant(m.id);
				this.applyStage(m.raised ? raiseHand(this.stage(), m.id) : lowerHand(this.stage(), m.id));
				break;
			}
			case 'take_slot': {
				this.requireSelf(m.id, 'You can only take your own slot');
				this.requireParticipant(m.id);
				this.applyStage(takeSlot(this.stage(), m.id, m.media));
				break;
			}
			case 'release_slot': {
				this.requireSelf(m.id, 'You can only release your own slot');
				this.requireParticipant(m.id);
				this.applyStage(releaseSlot(this.stage(), m.id, m.media));
				break;
			}
			case 'set_muted': {
				this.requireSelf(m.id, 'You can only mute yourself');
				const self = this.requireParticipant(m.id);
				self.muted = m.muted;
				this.applyStage(
					m.muted ? mutedAudio(this.stage(), m.id) : unmutedAudio(this.stage(), m.id)
				);
				break;
			}
			case 'grant_slot': {
				this.requireHostForRoom();
				this.requireParticipant(m.id);
				this.applyStage(grantSlot(this.stage(), m.id, m.media));
				break;
			}
			case 'revoke_slot': {
				this.requireHostForRoom();
				this.applyStage(revokeSlot(this.stage(), m.id, m.media));
				break;
			}
			case 'add_placer': {
				this.requireHostForRoom();
				// Laid down CLEAR of anyone standing there AND of other placers. A
				// placer may legitimately be moved under content afterwards — it
				// holds no space — but spawning underneath something makes it
				// unreachable by pointer, and the host is left with a control
				// they can see and cannot grab. Stacked placers are the worse
				// case: identical dashed boxes, where the top one silently eats
				// every gesture aimed at the one below.
				const clear = nearestLegal(shapeOfPlacer(m.placer), [
					...this.shapes(),
					...this.state.placers.map((existing) => shapeOfPlacer(existing))
				]);
				this.state.placers = [...this.state.placers, { ...m.placer, x: clear.x, y: clear.y }];
				break;
			}
			case 'update_placer': {
				this.requireHostForRoom();
				const at = this.state.placers.findIndex((placer) => placer.id === m.placer.id);
				if (at === -1) throw new StoreRejection('invalid', 'Unknown placer');
				this.state.placers[at] = { ...m.placer };
				break;
			}
			case 'remove_placer': {
				this.requireHostForRoom();
				// Numbering is array position, so removing one renumbers the rest.
				// That is the point: "newcomer 4" with no newcomer 3 is a puzzle.
				this.state.placers = this.state.placers.filter((placer) => placer.id !== m.id);
				break;
			}
			case 'set_capacity': {
				this.requireHostForRoom();
				this.applyStage(applyCapacity(this.stage(), m.capacity));
				break;
			}
			case 'set_away': {
				// UX-AV-7: emotes are self-initiated — you may only change your own.
				this.requireSelf(m.id, 'You can only emote yourself');
				this.requireParticipant(m.id).away = m.away;
				break;
			}
			case 'set_clip': {
				const existing = this.requireObject(m.id);
				this.requireEditable(existing);
				existing.clip = m.clip;
				existing.updated_at = nowIso();
				break;
			}
			case 'set_identity': {
				this.requireSelf(m.id, 'You can only change your own name');
				const participant = this.requireParticipant(m.id);
				participant.name = m.name;
				participant.emoji = m.emoji;
				break;
			}
			case 'set_background': {
				// Room-level state. Host-gating arrives with the host role (UX-ROOM-6);
				// for now, open like other room edits in the stub.
				this.state.background = m.value;
				break;
			}
			case 'set_room_meta': {
				this.state.title = m.title;
				this.state.description = m.description;
				break;
			}
			case 'save_config': {
				this.state.configurations[m.id] = {
					id: m.id,
					name: m.name,
					snapshot: this.captureSnapshot()
				};
				this.state.active_config = m.id;
				break;
			}
			case 'update_config': {
				// UX-ROOM-4: you can only edit the configuration you are IN.
				if (this.state.active_config === null) {
					throw new StoreRejection('invalid', 'Switch to a configuration before updating it');
				}
				const config = this.state.configurations[this.state.active_config];
				if (config === undefined) throw new StoreRejection('invalid', 'Unknown configuration');
				config.snapshot = this.captureSnapshot();
				break;
			}
			case 'rename_config': {
				const config = this.state.configurations[m.id];
				if (config === undefined) throw new StoreRejection('invalid', 'Unknown configuration');
				config.name = m.name;
				break;
			}
			case 'switch_config': {
				const config = this.state.configurations[m.id];
				if (config === undefined) throw new StoreRejection('invalid', 'Unknown configuration');
				this.state.active_config = m.id;
				this.applySnapshot(config.snapshot);
				// AR-CTRL-4 says locations are read at entry AND on configuration
				// switch, which nothing did before: people simply stayed where the
				// previous layout had put them. Now everyone is re-placed by the
				// same three-step rule, so a configuration genuinely restores where
				// people were IN IT (UX-AV-9) rather than only where objects were.
				this.replaceEveryone();
				break;
			}
			case 'reset_config': {
				// UX-ROOM-5: restore the active config's layout; content untouched.
				if (this.state.active_config === null) break;
				const config = this.state.configurations[this.state.active_config];
				if (config !== undefined) this.applySnapshot(config.snapshot);
				break;
			}
			case 'delete_config': {
				this.state.configurations = omitKey(this.state.configurations, m.id);
				if (this.state.active_config === m.id) this.state.active_config = null;
				break;
			}
		}
	}

	/**
	 * Apply a configuration snapshot: set each present object's transform, and
	 * the background/title/description. DEFERRED (DESIGN.md open item): objects
	 * absent from the snapshot are left in place — hide-vs-remove is unresolved.
	 */
	/**
	 * Re-apply a configuration's layout: position, size, and visibility, plus
	 * the room's own background and titles. Content is never touched
	 * (UX-ROOM-5) — note text and chat logs survive every switch.
	 *
	 * Typed from the schema rather than restated inline, so the shape cannot
	 * drift from what is actually persisted.
	 *
	 * Objects with no entry in the snapshot keep their current layout. That is
	 * no longer the old unresolved "hide vs remove" question: save_config
	 * captures EVERY object, so a missing entry only happens for an object
	 * created after the configuration was saved, and leaving a brand-new object
	 * where its author just put it is the least surprising thing to do.
	 */
	/**
	 * The current LAYOUT as a snapshot (UX-ROOM-3): position, size, and
	 * visibility per object, plus the room's background and titles. Shared by
	 * save_config and update_config so the two can never capture different
	 * things — which is exactly the drift that makes "update" untrustworthy.
	 */
	private captureSnapshot(): ConfigSnapshot {
		const poses: Record<string, Pose> = {};
		for (const [id, o] of Object.entries(this.state.objects)) {
			poses[id] = { transform: { ...o.transform }, hidden: o.hidden };
		}
		return {
			poses,
			// Capacity is per-configuration (UX-STAGE-1), so it travels with the
			// snapshot and is re-applied on switch (AR-MEDIA-1).
			capacity: { ...this.state.capacity },
			placers: this.state.placers.map((placer) => ({ ...placer })),
			background: this.state.background,
			title: this.state.title,
			description: this.state.description
		};
	}

	private applySnapshot(snapshot: ConfigSnapshot): void {
		for (const [id, pose] of Object.entries(snapshot.poses)) {
			const object = this.state.objects[id];
			if (object === undefined) continue;
			object.transform = { ...pose.transform };
			object.hidden = pose.hidden;
		}
		// AR-MEDIA-1: caps are re-read on a configuration switch, and lowering
		// one releases holders beyond it, in reverse acquisition order, to the
		// queue. Routing through applyCapacity means switch and reset get that
		// for free rather than each reimplementing it.
		this.applyStage(applyCapacity(this.stage(), snapshot.capacity));
		this.state.placers = snapshot.placers.map((placer) => ({ ...placer }));
		this.state.background = snapshot.background;
		this.state.title = snapshot.title;
		this.state.description = snapshot.description;
	}

	/** Key for AR-CTRL-6's table. room_id is implicit: this store IS one room. */
	private locationKey(participantId: string): string {
		return locationKey(participantId, this.state.active_config);
	}

	/**
	 * The lowest-numbered placer nobody is standing in (UX-AV-2).
	 *
	 * Occupancy is DERIVED from where people actually are, not tracked in a
	 * separate assignment table. A table would be a second source of truth that
	 * drifts the moment someone wanders off, leaves in a lost tab, or is
	 * re-placed by a configuration switch — and it would have to be reconciled
	 * on every one of those. Deriving it also gives "leaving frees the spot"
	 * for nothing, because leaving is what makes the spot legal again.
	 */
	private freePlacer(excludeId: string): Placer | undefined {
		return this.state.placers.find((placer) =>
			placementLegal(shapeOfPlacer(placer), this.shapes(excludeId))
		);
	}

	/**
	 * How someone arrives (AR-CTRL-4 / UX-AV-2), in the order the requirement
	 * states: remembered spot for THIS configuration → the lowest-numbered free
	 * placer → the nearest legal position (UX-OBJ-12).
	 *
	 * Returns GEOMETRY, not just a point, because a placer defines the arrival:
	 * whoever lands in one adopts its size, rotation, and shape. That is what
	 * makes a placer's resize and rotate handles mean something rather than
	 * decorate a marker — a host lays out tilted hexagonal seats and arrivals
	 * take that form.
	 *
	 * A remembered location is RE-VALIDATED, not trusted: the layout may have
	 * changed since, so an illegal remembered spot falls through to the same
	 * search rather than dropping someone on top of content. Note what it does
	 * NOT do — fall through to a placer. Someone returning to a room they have
	 * been in before is not a newcomer, and putting them in the newcomer seat
	 * would take it from the person it is for.
	 */
	private entryPlacement(participant: Participant): {
		location: Point;
		size: Size;
		rotation: number;
		clip: Clip;
	} {
		const own = {
			size: participant.size,
			rotation: participant.rotation,
			clip: participant.clip
		};
		const remembered = this.state.participant_locations[this.locationKey(participant.id)];
		if (remembered !== undefined) {
			const shape = { ...shapeOfParticipant(participant), x: remembered.x, y: remembered.y };
			return { ...own, location: nearestLegal(shape, this.shapes(participant.id)) };
		}

		const placer = this.freePlacer(participant.id);
		if (placer !== undefined) {
			return {
				location: nearestLegal(shapeOfPlacer(placer), this.shapes(participant.id)),
				size: { width: placer.width, height: placer.height },
				rotation: placer.rotation,
				clip: { ...placer.clip }
			};
		}

		// No memory and no free placer: the behaviour every room had before
		// placers existed. Not an error — a configuration need not have any.
		const shape = { ...shapeOfParticipant(participant), x: 0, y: 0 };
		return { ...own, location: nearestLegal(shape, this.shapes(participant.id)) };
	}

	/**
	 * Re-place every participant for the now-active configuration. Ordered by
	 * id so the result does not depend on object iteration order, and each
	 * person is excluded from their own obstacle set so they can land on the
	 * spot they are already standing in.
	 */
	private replaceEveryone(): void {
		for (const id of Object.keys(this.state.participants).sort()) {
			const participant = this.state.participants[id];
			if (participant === undefined) continue;
			const placement = this.entryPlacement(participant);
			participant.location = placement.location;
			participant.size = placement.size;
			participant.rotation = placement.rotation;
			participant.clip = placement.clip;
		}
	}

	private requireParticipant(id: string): Participant {
		const participant = this.state.participants[id];
		if (participant === undefined) throw new StoreRejection('invalid', 'Unknown participant');
		return participant;
	}

	private requireObject(id: string): CanvasObject {
		const object = this.state.objects[id];
		if (object === undefined) throw new StoreRejection('invalid', 'Unknown object');
		return object;
	}

	/**
	 * Self-only gate. Your avatar and your expression are yours: emotes
	 * (UX-AV-7) and now avatar size/shape (UX-AV-1) are all things only you may
	 * change about your own representation, independent of object permissions.
	 */
	private requireSelf(id: string, message: string): void {
		if (id !== this.actorId) throw new StoreRejection('permission', message);
	}

	/**
	 * UX-OBJ-9's room-level creation gate. Like canEdit's host branch, the
	 * restricted value is enforceable but unreachable until the host role
	 * exists (AR-CTRL-5) — so today this only ever admits.
	 */
	private requireMayCreate(): void {
		if (this.state.create_permission === 'all') return;
		// 'host' is enforced honestly, which today means it admits NOBODY: the
		// role arrives with admission (AR-CTRL-5) and until then a room has no
		// hosts. The alternative — quietly letting everyone create anyway —
		// would make the setting a lie, so the UI warns instead.
		throw new StoreRejection('permission', 'Only hosts may add objects in this room');
	}

	/** Room settings are host-only once the role exists; open until then. */
	private requireHostForRoom(): void {
		// Deliberately a no-op, mirroring canEdit's documented precedent: the
		// gate is written where it belongs so it lights up with the role rather
		// than being retrofitted.
	}

	private requireEditable(object: CanvasObject): void {
		// Host role arrives with admission; until then nobody is a host.
		if (!canEdit(object, this.actorId, false)) {
			throw new StoreRejection('permission', 'You do not have permission to edit this');
		}
	}

	sendEphemeral(message: EphemeralMessage): void {
		// A drag can race a room navigation; a send after dispose is a no-op,
		// not a crash.
		if (this.closed) return;
		this.channel?.postMessage({ v: 1, t: 'ephemeral', message });
	}

	onEphemeral(handler: (message: EphemeralMessage) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	dispose(): void {
		this.closed = true;
		this.channel?.close();
		this.handlers.clear();
	}
}

/**
 * Whether an object takes part in collision at all (UX-OBJ-12's exemptions).
 *
 * Drawings do not. Ink is annotation: it belongs ON TOP of the things it
 * annotates, and a stroke's axis-aligned bounding box is mostly empty anyway —
 * a diagonal squiggle reserved a huge rectangle. Worse, drawings carry
 * border.width 0, so they got no sticker inset and reserved their FULL box,
 * making them stricter obstacles than notes.
 *
 * One predicate, called from every site, because the rule has to hold on both
 * sides of the seam: exempting only the client would let a drawing be dragged
 * freely and then snap back on commit, and exempting only the store would
 * leave the drag feeling blocked.
 */
export function participatesInCollision(object: CanvasObject): boolean {
	return object.type !== 'drawing';
}

/**
 * The one place a SolverShape is built.
 *
 * The three public `shapeOf*` functions below were independent copies of this
 * record — same nine fields, same order, differing only in where the numbers
 * came from. `SolverShape` is the collider's contract, so adding a field meant
 * editing three sites, and missing one would degrade collision for a single
 * entity class. Collision bugs present as "it snapped back for no reason",
 * which is the kind nobody files.
 *
 * The `circle`/`points` pair is the fragile part: they have to agree, and that
 * invariant was restated three times.
 */
function solverShape(
	id: string,
	x: number,
	y: number,
	size: Size,
	rotation: number,
	clip: Clip,
	border: number
): SolverShape {
	return {
		id,
		x,
		y,
		width: size.width,
		height: size.height,
		rotation,
		circle: clip.shape === 'circle',
		points: outlinePoints(clip),
		border
	};
}

export function shapeOfObject(object: CanvasObject): SolverShape {
	const t = object.transform;
	return solverShape(object.id, t.x, t.y, t, t.rotation, object.clip, object.border.width);
}

/**
 * The clip's outline as percentage points, or undefined for shapes the solver
 * handles directly (a plain rect, or a circle via its exact fast path).
 * Ellipses are tessellated here so the solver never has to know about clips.
 */
export function outlinePoints(clip: Clip): readonly { x: number; y: number }[] | undefined {
	switch (clip.shape) {
		case 'ellipse':
			return ellipsePoints();
		case 'polygon':
			return clip.points;
		default:
			return undefined;
	}
}

/**
 * Solver view of a placer, used only to ask whether anyone is standing in it.
 * A placer never enters the obstacle set itself — it holds no space, so people
 * and content pass through it freely. Borrows the avatar border so "occupied"
 * means the same thing here as it does between two avatars.
 */
export function shapeOfPlacer(placer: Placer): SolverShape {
	return solverShape(placer.id, placer.x, placer.y, placer, placer.rotation, placer.clip, AVATAR_BORDER);
}

export function shapeOfParticipant(participant: Participant): SolverShape {
	// Reads the participant's own size and clip now that avatars are resizable
	// and reshapeable (UX-AV-1) — using the AVATAR_SIZE constant here would
	// have let a resized avatar collide as though it were still the default.
	return solverShape(
		participant.id,
		participant.location.x,
		participant.location.y,
		participant.size,
		participant.rotation,
		participant.clip,
		AVATAR_BORDER
	);
}


function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
