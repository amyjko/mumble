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
	Layout,
	EphemeralMessage,
	Mutation,
	Participant,
	RoomState,
	Transform
} from '$lib/model/types';
import { untrack } from 'svelte';
import { canEdit } from '$lib/model/permissions';
import { ellipsePoints, nearestLegal, placementLegal } from '$lib/canvas/geometry';
import { applyEncodedUpdate, docFromEncoded, encodeDoc, mergeEncoded, noteText } from '$lib/model/ydoc';
import type { Clip, SolverShape } from '$lib/model/types';
import type { RoomStore } from './room-store';

function freshState(): RoomState {
	return { objects: {}, participants: {}, background: '', title: '', description: '', create_permission: 'all', border_default: DEFAULT_BORDER_WIDTH, configurations: {}, active_config: null };
}

/**
 * Stub-only cap on a chat object's retained log (see post_message). Exported so
 * the UI can say so rather than dropping messages silently.
 */
export const CHAT_LOG_LIMIT = 500;

export const AVATAR_SIZE = 96;
export const AVATAR_BORDER = 6;

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
				const spot = nearestLegal(shapeOfParticipant(m.participant), this.shapes(m.participant.id));
				const participant: Participant = { ...m.participant, location: spot };
				this.state.participants[participant.id] = participant;
				break;
			}
			case 'move_participant': {
				const existing = this.state.participants[m.id];
				if (existing === undefined) throw new StoreRejection('invalid', 'Unknown participant');
				const moved = { ...shapeOfParticipant(existing), x: m.location.x, y: m.location.y };
				if (!placementLegal(moved, this.shapes(m.id))) {
					throw new StoreRejection('overlap', 'That placement overlaps content');
				}
				existing.location = m.location;
				break;
			}
			case 'remove_participant': {
				this.state.participants = omitKey(this.state.participants, m.id);
				break;
			}
			case 'size_participant': {
				// Resize/rotate an avatar (UX-AV-1). Revalidated against the same
				// solver as a move: growing an avatar into a neighbor is exactly as
				// illegal as dragging it there, and only the store sees both.
				const existing = this.state.participants[m.id];
				if (existing === undefined) throw new StoreRejection('invalid', 'Unknown participant');
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
				const existing = this.state.participants[m.id];
				if (existing === undefined) throw new StoreRejection('invalid', 'Unknown participant');
				this.requireSelf(m.id, 'You can only reshape your own avatar');
				existing.clip = m.clip;
				break;
			}
			case 'set_hand':
			case 'set_away': {
				// UX-AV-7: emotes are self-initiated — you may only change your own.
				this.requireSelf(m.id, 'You can only emote yourself');
				const participant = this.state.participants[m.id];
				if (participant === undefined) throw new StoreRejection('invalid', 'Unknown participant');
				if (m.kind === 'set_hand') participant.raised_hand = m.raised;
				else participant.away = m.away;
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
				const participant = this.state.participants[m.id];
				if (participant === undefined) throw new StoreRejection('invalid', 'Unknown participant');
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
		const layouts: Record<string, Layout> = {};
		for (const [id, o] of Object.entries(this.state.objects)) {
			layouts[id] = { transform: { ...o.transform }, hidden: o.hidden };
		}
		return {
			layouts,
			background: this.state.background,
			title: this.state.title,
			description: this.state.description
		};
	}

	private applySnapshot(snapshot: ConfigSnapshot): void {
		for (const [id, layout] of Object.entries(snapshot.layouts)) {
			const object = this.state.objects[id];
			if (object === undefined) continue;
			object.transform = { ...layout.transform };
			object.hidden = layout.hidden;
		}
		this.state.background = snapshot.background;
		this.state.title = snapshot.title;
		this.state.description = snapshot.description;
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

export function shapeOfObject(object: CanvasObject): SolverShape {
	return {
		id: object.id,
		x: object.transform.x,
		y: object.transform.y,
		width: object.transform.width,
		height: object.transform.height,
		rotation: object.transform.rotation,
		circle: object.clip.shape === 'circle',
		points: outlinePoints(object.clip),
		border: object.border.width
	};
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

export function shapeOfParticipant(participant: Participant): SolverShape {
	// Reads the participant's own size and clip now that avatars are resizable
	// and reshapeable (UX-AV-1) — using the AVATAR_SIZE constant here would
	// have let a resized avatar collide as though it were still the default.
	return {
		id: participant.id,
		x: participant.location.x,
		y: participant.location.y,
		width: participant.size.width,
		height: participant.size.height,
		rotation: participant.rotation,
		circle: participant.clip.shape === 'circle',
		points: outlinePoints(participant.clip),
		border: AVATAR_BORDER
	};
}

export function transformFromShapeMove(transform: Transform, x: number, y: number): Transform {
	return { ...transform, x, y };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
