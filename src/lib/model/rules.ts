import { StoreRejection, nowIso, omitKey } from './types';
import type {
	CanvasObject,
	ConfigSnapshot,
	Mutation,
	Participant,
	Placer,
	Point,
	Pose,
	RoomState,
	Size,
	SolverShape,
	Clip
} from './types';
import { canEdit } from './permissions';
import { nearestLegal, placementLegal } from '$lib/canvas/geometry';
import { locationKey } from './placement';
import { applyEncodedUpdate, docFromEncoded, encodeDoc, noteText } from './ydoc';
import {
	admits,
	applyCapacity,
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
} from './stage';
import { shapeOfObject, shapeOfPlacer, shapeOfParticipant, participatesInCollision } from './shapes';
import { CHAT_LOG_LIMIT } from './limits';

/**
 * THE RULE ENGINE: every permission check, every validity check, and every
 * state transition the product has — with no storage, no transport, and no
 * `this`.
 *
 * It lives apart from any store because AR-SYNC-3 requires the SAME rules to
 * run in two places: the server enforces them before writing, and the client
 * runs them for responsiveness ("client-side checks exist only for
 * responsiveness"). Two implementations of one rulebook is how the rulebook
 * drifts — and the audit that produced this refactor found three drifts of
 * exactly that shape in the gesture layer alone.
 *
 * So MemoryRoomStore is now storage + reactivity around this module, and the
 * Supabase-backed store will be Postgres + Realtime around the same module.
 *
 * MUTATES `state` IN PLACE rather than returning a new object. That is
 * deliberate, not laziness: the client passes a Svelte `$state` proxy, and
 * fine-grained reactivity depends on writing through it. Wholesale replacement
 * would re-render the entire canvas on every keystroke. The server passes a
 * plain object and persists whatever changed.
 */
export interface RuleContext {
	/** Who is acting. On the server this comes from the verified JWT, never the caller. */
	actorId: string;
	/**
	 * Whether the actor holds the host role in this room (UX-PERM-3).
	 * Still `false` everywhere until the role lands; the gates are written.
	 */
	isHost: boolean;
}

export interface ApplyOutcome {
	/**
	 * Chat messages evicted by the stub's log cap. Returned rather than
	 * counted in the store, because the cap is a storage concession the UI
	 * surfaces (UX-OBJ-3 deviation) and the rules must not own store state.
	 */
	droppedMessages: number;
}


/**
 * The stage slice, lifted out of room state and put back. Every stage case
 * below is then ONE call into the pure module — which is what AR-TEST-4
 * means by the capacity/queue rules staying extractable.
 */
function stage(state: RoomState): StageState {
	return {
		capacity: state.capacity,
		video_holders: state.video_holders,
		audio_holders: state.audio_holders,
		queue: state.queue
	};
}

function applyStage(state: RoomState, next: StageState): void {
	state.capacity = next.capacity;
	state.video_holders = next.video_holders;
	state.audio_holders = next.audio_holders;
	state.queue = next.queue;
}

/** Solver view of current occupancy (objects + avatars), minus exclusions. */
function shapes(state: RoomState, excludeId?: string): SolverShape[] {
	const out: SolverShape[] = [];
	for (const object of Object.values(state.objects)) {
		if (object.id === excludeId) continue;
		if (!participatesInCollision(object)) continue;
		// A hidden object holds no space (UX-ROOM-3): an obstacle nobody can
		// see is worse than an overlap. This has to match the client's
		// `occupying` list exactly — one rule, two enforcement points.
		if (object.hidden) continue;
		out.push(shapeOfObject(object));
	}
	for (const participant of Object.values(state.participants)) {
		if (participant.id === excludeId) continue;
		out.push(shapeOfParticipant(participant));
	}
	return out;
}
/** The commit-side gate: permissions (UX-PERM) + overlap (AR-CANVAS-5). */
export function applyMutation(state: RoomState, m: Mutation, ctx: RuleContext): ApplyOutcome {
	const outcome: ApplyOutcome = { droppedMessages: 0 };
	switch (m.kind) {
		case 'create_object': {
			// UX-OBJ-9: creation is gated by a ROOM setting, before anything
			// else — placement should not be computed for a create that is
			// about to be refused.
			requireMayCreate(state);
			// Exempt objects land exactly where they were made. Relocating a
			// just-finished stroke off the ink the user drew was the most
			// visible symptom of drawings taking part in collision.
			const spot = participatesInCollision(m.object)
				? nearestLegal(shapeOfObject(m.object), shapes(state, m.object.id))
				: { x: m.object.transform.x, y: m.object.transform.y };
			const object: CanvasObject = {
				...m.object,
				transform: { ...m.object.transform, x: spot.x, y: spot.y }
			};
			state.objects[object.id] = object;
			break;
		}
		case 'move_object': {
			const existing = requireObject(state, m.id);
			requireEditable(existing, ctx);
			const moved = { ...shapeOfObject(existing), x: m.transform.x, y: m.transform.y, width: m.transform.width, height: m.transform.height };
			if (participatesInCollision(existing) && !placementLegal(moved, shapes(state, m.id))) {
				throw new StoreRejection('overlap', 'That placement overlaps content');
			}
			existing.transform = m.transform;
			existing.updated_at = nowIso();
			break;
		}
		case 'edit_note': {
			const existing = requireObject(state, m.id);
			// Permission is checked ONCE per edit, at the mutation boundary.
			// See the note on session-scoped gating in the class doc.
			requireEditable(existing, ctx);
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
			const existing = requireObject(state, m.id);
			requireEditable(existing, ctx);
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
			const existing = requireObject(state, m.id);
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
			outcome.droppedMessages += withNew.length - existing.payload.messages.length;
			existing.updated_at = nowIso();
			break;
		}
		case 'set_border': {
			const existing = requireObject(state, m.id);
			// "subject to edit permission" (UX-OBJ-8), so this is the editable
			// gate rather than the creator-only one that guards permission.
			requireEditable(existing, ctx);
			// Narrowing a border widens the object's CONTENT, because the
			// border width is the overlap tolerance (UX-OBJ-12) — so the new
			// size has to be revalidated exactly like a move.
			const widened = { ...shapeOfObject(existing), border: m.width };
			if (participatesInCollision(existing) && !placementLegal(widened, shapes(state, m.id))) {
				throw new StoreRejection('overlap', 'A thinner border would overlap neighbouring content');
			}
			existing.border = { width: m.width };
			existing.updated_at = nowIso();
			break;
		}
		case 'set_room_border': {
			requireHostForRoom(ctx);
			state.border_default = m.width;
			break;
		}
		case 'set_permission': {
			const existing = requireObject(state, m.id);
			// Creator-only, NOT requireEditable: with permission 'all' anyone
			// can edit an object, and letting them also re-lock it would let a
			// passer-by take it from its creator.
			if (existing.creator_id !== ctx.actorId) {
				throw new StoreRejection('permission', 'Only the creator can change who may edit this');
			}
			existing.permission = m.permission;
			existing.updated_at = nowIso();
			break;
		}
		case 'set_room_create_permission': {
			requireHostForRoom(ctx);
			state.create_permission = m.value;
			break;
		}
		case 'set_hidden': {
			const existing = requireObject(state, m.id);
			requireEditable(existing, ctx);
			// Unhiding must land somewhere legal: while hidden the object is
			// excluded from occupancy, so the space it used to hold may have
			// been taken. Same primitive arrivals use (AR-CTRL-4).
			if (!m.hidden) {
				const spot = nearestLegal(
					{ ...shapeOfObject(existing), x: existing.transform.x, y: existing.transform.y },
					shapes(state, m.id)
				);
				existing.transform = { ...existing.transform, x: spot.x, y: spot.y };
			}
			existing.hidden = m.hidden;
			existing.updated_at = nowIso();
			break;
		}
		case 'delete_object': {
			const existing = requireObject(state, m.id);
			requireEditable(existing, ctx);
			state.objects = omitKey(state.objects, m.id);
			break;
		}
		case 'upsert_participant': {
			// UX-STAGE-11: admission is refused once the room is full. Someone
			// already present is never turned away for being present.
			const present = Object.keys(state.participants).length;
			const already = state.participants[m.participant.id] !== undefined;
			if (!admits(stage(state), present, already)) {
				throw new StoreRejection('permission', 'This room is full');
			}
			const located: Participant = { ...m.participant, ...entryPlacement(state, m.participant) };
			state.participants[located.id] = located;
			break;
		}
		case 'move_participant': {
			const existing = requireParticipant(state, m.id);
			const moved = { ...shapeOfParticipant(existing), x: m.location.x, y: m.location.y };
			if (!placementLegal(moved, shapes(state, m.id))) {
				throw new StoreRejection('overlap', 'That placement overlaps content');
			}
			existing.location = m.location;
			// AR-CTRL-6: remembered placement is written on drop, keyed per
			// configuration, so it can be read back on entry and on switch.
			state.participant_locations[locationKeyFor(state, m.id)] = { ...m.location };
			break;
		}
		case 'remove_participant': {
			state.participants = omitKey(state.participants, m.id);
			// Leaving releases both slots and drops you from the queue
			// (UX-STAGE-4) — a queue holding absent people hands slots to
			// nobody.
			applyStage(state, participantLeft(stage(state), m.id));
			break;
		}
		case 'size_participant': {
			// Resize/rotate an avatar (UX-AV-1). Revalidated against the same
			// solver as a move: growing an avatar into a neighbor is exactly as
			// illegal as dragging it there, and only the store sees both.
			const existing = requireParticipant(state, m.id);
			requireSelf(ctx, m.id, 'You can only resize your own avatar');
			const sized = {
				...shapeOfParticipant(existing),
				x: m.location.x,
				y: m.location.y,
				width: m.size.width,
				height: m.size.height
			};
			if (!placementLegal(sized, shapes(state, m.id))) {
				throw new StoreRejection('overlap', 'That placement overlaps content');
			}
			existing.location = m.location;
			existing.size = m.size;
			existing.rotation = m.rotation;
			break;
		}
		case 'set_participant_clip': {
			const existing = requireParticipant(state, m.id);
			requireSelf(ctx, m.id, 'You can only reshape your own avatar');
			existing.clip = m.clip;
			break;
		}
		case 'set_hand': {
			// UX-AV-6: raising a hand IS entering the slot queue. It is no
			// longer a stored flag, so there is nothing to keep in sync.
			requireSelf(ctx, m.id, 'You can only raise your own hand');
			requireParticipant(state, m.id);
			applyStage(state, m.raised ? raiseHand(stage(state), m.id) : lowerHand(stage(state), m.id));
			break;
		}
		case 'take_slot': {
			requireSelf(ctx, m.id, 'You can only take your own slot');
			requireParticipant(state, m.id);
			applyStage(state, takeSlot(stage(state), m.id, m.media));
			break;
		}
		case 'release_slot': {
			requireSelf(ctx, m.id, 'You can only release your own slot');
			requireParticipant(state, m.id);
			applyStage(state, releaseSlot(stage(state), m.id, m.media));
			break;
		}
		case 'set_muted': {
			requireSelf(ctx, m.id, 'You can only mute yourself');
			const self = requireParticipant(state, m.id);
			self.muted = m.muted;
			applyStage(state, 
				m.muted ? mutedAudio(stage(state), m.id) : unmutedAudio(stage(state), m.id)
			);
			break;
		}
		case 'grant_slot': {
			requireHostForRoom(ctx);
			requireParticipant(state, m.id);
			applyStage(state, grantSlot(stage(state), m.id, m.media));
			break;
		}
		case 'revoke_slot': {
			requireHostForRoom(ctx);
			applyStage(state, revokeSlot(stage(state), m.id, m.media));
			break;
		}
		case 'add_placer': {
			requireHostForRoom(ctx);
			// Laid down CLEAR of anyone standing there AND of other placers. A
			// placer may legitimately be moved under content afterwards — it
			// holds no space — but spawning underneath something makes it
			// unreachable by pointer, and the host is left with a control
			// they can see and cannot grab. Stacked placers are the worse
			// case: identical dashed boxes, where the top one silently eats
			// every gesture aimed at the one below.
			const clear = nearestLegal(shapeOfPlacer(m.placer), [
				...shapes(state),
				...state.placers.map((existing) => shapeOfPlacer(existing))
			]);
			state.placers = [...state.placers, { ...m.placer, x: clear.x, y: clear.y }];
			break;
		}
		case 'update_placer': {
			requireHostForRoom(ctx);
			const at = state.placers.findIndex((placer) => placer.id === m.placer.id);
			if (at === -1) throw new StoreRejection('invalid', 'Unknown placer');
			state.placers[at] = { ...m.placer };
			break;
		}
		case 'remove_placer': {
			requireHostForRoom(ctx);
			// Numbering is array position, so removing one renumbers the rest.
			// That is the point: "newcomer 4" with no newcomer 3 is a puzzle.
			state.placers = state.placers.filter((placer) => placer.id !== m.id);
			break;
		}
		case 'set_capacity': {
			requireHostForRoom(ctx);
			applyStage(state, applyCapacity(stage(state), m.capacity));
			break;
		}
		case 'set_away': {
			// UX-AV-7: emotes are self-initiated — you may only change your own.
			requireSelf(ctx, m.id, 'You can only emote yourself');
			requireParticipant(state, m.id).away = m.away;
			break;
		}
		case 'set_clip': {
			const existing = requireObject(state, m.id);
			requireEditable(existing, ctx);
			existing.clip = m.clip;
			existing.updated_at = nowIso();
			break;
		}
		case 'set_identity': {
			requireSelf(ctx, m.id, 'You can only change your own name');
			const participant = requireParticipant(state, m.id);
			participant.name = m.name;
			participant.emoji = m.emoji;
			break;
		}
		case 'set_background': {
			// Room-level state. Host-gating arrives with the host role (UX-ROOM-6);
			// for now, open like other room edits in the stub.
			state.background = m.value;
			break;
		}
		case 'set_room_meta': {
			state.title = m.title;
			state.description = m.description;
			break;
		}
		case 'save_config': {
			state.configurations[m.id] = {
				id: m.id,
				name: m.name,
				snapshot: captureSnapshot(state)
			};
			state.active_config = m.id;
			break;
		}
		case 'update_config': {
			// UX-ROOM-4: you can only edit the configuration you are IN.
			if (state.active_config === null) {
				throw new StoreRejection('invalid', 'Switch to a configuration before updating it');
			}
			const config = state.configurations[state.active_config];
			if (config === undefined) throw new StoreRejection('invalid', 'Unknown configuration');
			config.snapshot = captureSnapshot(state);
			break;
		}
		case 'rename_config': {
			const config = state.configurations[m.id];
			if (config === undefined) throw new StoreRejection('invalid', 'Unknown configuration');
			config.name = m.name;
			break;
		}
		case 'switch_config': {
			const config = state.configurations[m.id];
			if (config === undefined) throw new StoreRejection('invalid', 'Unknown configuration');
			state.active_config = m.id;
			applySnapshot(state, config.snapshot);
			// AR-CTRL-4 says locations are read at entry AND on configuration
			// switch, which nothing did before: people simply stayed where the
			// previous layout had put them. Now everyone is re-placed by the
			// same three-step rule, so a configuration genuinely restores where
			// people were IN IT (UX-AV-9) rather than only where objects were.
			replaceEveryone(state);
			break;
		}
		case 'reset_config': {
			// UX-ROOM-5: restore the active config's layout; content untouched.
			if (state.active_config === null) break;
			const config = state.configurations[state.active_config];
			if (config !== undefined) applySnapshot(state, config.snapshot);
			break;
		}
		case 'delete_config': {
			state.configurations = omitKey(state.configurations, m.id);
			if (state.active_config === m.id) state.active_config = null;
			break;
		}
	}
	return outcome;
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
function captureSnapshot(state: RoomState): ConfigSnapshot {
	const poses: Record<string, Pose> = {};
	for (const [id, o] of Object.entries(state.objects)) {
		poses[id] = { transform: { ...o.transform }, hidden: o.hidden };
	}
	return {
		poses,
		// Capacity is per-configuration (UX-STAGE-1), so it travels with the
		// snapshot and is re-applied on switch (AR-MEDIA-1).
		capacity: { ...state.capacity },
		placers: state.placers.map((placer) => ({ ...placer })),
		background: state.background,
		title: state.title,
		description: state.description
	};
}

function applySnapshot(state: RoomState, snapshot: ConfigSnapshot): void {
	for (const [id, pose] of Object.entries(snapshot.poses)) {
		const object = state.objects[id];
		if (object === undefined) continue;
		object.transform = { ...pose.transform };
		object.hidden = pose.hidden;
	}
	// AR-MEDIA-1: caps are re-read on a configuration switch, and lowering
	// one releases holders beyond it, in reverse acquisition order, to the
	// queue. Routing through applyCapacity means switch and reset get that
	// for free rather than each reimplementing it.
	applyStage(state, applyCapacity(stage(state), snapshot.capacity));
	state.placers = snapshot.placers.map((placer) => ({ ...placer }));
	state.background = snapshot.background;
	state.title = snapshot.title;
	state.description = snapshot.description;
}

/** Key for AR-CTRL-6's table. room_id is implicit: this store IS one room. */
function locationKeyFor(state: RoomState, participantId: string): string {
	return locationKey(participantId, state.active_config);
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
function freePlacer(state: RoomState, excludeId: string): Placer | undefined {
	return state.placers.find((placer) =>
		placementLegal(shapeOfPlacer(placer), shapes(state, excludeId))
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
function entryPlacement(state: RoomState, participant: Participant): {
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
	const remembered = state.participant_locations[locationKeyFor(state, participant.id)];
	if (remembered !== undefined) {
		const shape = { ...shapeOfParticipant(participant), x: remembered.x, y: remembered.y };
		return { ...own, location: nearestLegal(shape, shapes(state, participant.id)) };
	}

	const placer = freePlacer(state, participant.id);
	if (placer !== undefined) {
		return {
			location: nearestLegal(shapeOfPlacer(placer), shapes(state, participant.id)),
			size: { width: placer.width, height: placer.height },
			rotation: placer.rotation,
			clip: { ...placer.clip }
		};
	}

	// No memory and no free placer: the behaviour every room had before
	// placers existed. Not an error — a configuration need not have any.
	const shape = { ...shapeOfParticipant(participant), x: 0, y: 0 };
	return { ...own, location: nearestLegal(shape, shapes(state, participant.id)) };
}

/**
 * Re-place every participant for the now-active configuration. Ordered by
 * id so the result does not depend on object iteration order, and each
 * person is excluded from their own obstacle set so they can land on the
 * spot they are already standing in.
 */
function replaceEveryone(state: RoomState): void {
	for (const id of Object.keys(state.participants).sort()) {
		const participant = state.participants[id];
		if (participant === undefined) continue;
		const placement = entryPlacement(state, participant);
		participant.location = placement.location;
		participant.size = placement.size;
		participant.rotation = placement.rotation;
		participant.clip = placement.clip;
	}
}

function requireParticipant(state: RoomState, id: string): Participant {
	const participant = state.participants[id];
	if (participant === undefined) throw new StoreRejection('invalid', 'Unknown participant');
	return participant;
}

function requireObject(state: RoomState, id: string): CanvasObject {
	const object = state.objects[id];
	if (object === undefined) throw new StoreRejection('invalid', 'Unknown object');
	return object;
}

/**
 * Self-only gate. Your avatar and your expression are yours: emotes
 * (UX-AV-7) and now avatar size/shape (UX-AV-1) are all things only you may
 * change about your own representation, independent of object permissions.
 */
function requireSelf(ctx: RuleContext, id: string, message: string): void {
	if (id !== ctx.actorId) throw new StoreRejection('permission', message);
}

/**
 * UX-OBJ-9's room-level creation gate. Like canEdit's host branch, the
 * restricted value is enforceable but unreachable until the host role
 * exists (AR-CTRL-5) — so today this only ever admits.
 */
function requireMayCreate(state: RoomState): void {
	if (state.create_permission === 'all') return;
	// 'host' is enforced honestly, which today means it admits NOBODY: the
	// role arrives with admission (AR-CTRL-5) and until then a room has no
	// hosts. The alternative — quietly letting everyone create anyway —
	// would make the setting a lie, so the UI warns instead.
	throw new StoreRejection('permission', 'Only hosts may add objects in this room');
}

/** Room settings are host-only once the role exists; open until then. */
function requireHostForRoom(ctx: RuleContext): void {
	// Still a no-op, but now it has the fact it needs. Phase 4 makes this
	// `if (!ctx.isHost) throw new StoreRejection('permission', ...)` and the
	// eight call sites are already in the right places.
	void ctx;
}

function requireEditable(object: CanvasObject, ctx: RuleContext): void {
	// Host role arrives with admission; until then nobody is a host.
	if (!canEdit(object, ctx.actorId, false)) {
		throw new StoreRejection('permission', 'You do not have permission to edit this');
	}
}
