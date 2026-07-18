import {
	envelopeSchema,
	mutationSchema,
	parseJson,
	roomStateSchema
} from '$lib/model/schemas';
import { StoreRejection, nowIso, omitKey } from '$lib/model/types';
import type {
	CanvasObject,
	EphemeralMessage,
	Mutation,
	Participant,
	RoomState,
	Transform
} from '$lib/model/types';
import { untrack } from 'svelte';
import { canEdit } from '$lib/model/permissions';
import { nearestLegal, placementLegal } from '$lib/canvas/geometry';
import type { SolverShape } from '$lib/model/types';
import type { RoomStore } from './room-store';

function freshState(): RoomState {
	return { objects: {}, participants: {}, background: '', title: '', description: '', configurations: {}, active_config: null };
}

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
						this.state = envelope.state;
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
				const spot = nearestLegal(shapeOfObject(m.object), this.shapes(m.object.id));
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
				if (!placementLegal(moved, this.shapes(m.id))) {
					throw new StoreRejection('overlap', 'That placement overlaps content');
				}
				existing.transform = m.transform;
				existing.updated_at = nowIso();
				break;
			}
			case 'edit_note': {
				const existing = this.requireObject(m.id);
				this.requireEditable(existing);
				// The union now has >1 member, so the type guard is mandatory — the
				// norms re-imposing the check at compile time, exactly as predicted.
				if (existing.type !== 'note') throw new StoreRejection('invalid', 'Not a note');
				existing.payload = m.payload;
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
				// Bound the retained log so localStorage can't grow without limit.
				existing.payload.messages = [...existing.payload.messages, m.message].slice(-500);
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
				// Capture the current layout as a named snapshot (UX-ROOM-3).
				const transforms: Record<string, Transform> = {};
				for (const [id, o] of Object.entries(this.state.objects)) transforms[id] = { ...o.transform };
				this.state.configurations[m.id] = {
					id: m.id,
					name: m.name,
					snapshot: {
						transforms,
						background: this.state.background,
						title: this.state.title,
						description: this.state.description
					}
				};
				this.state.active_config = m.id;
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
	private applySnapshot(snapshot: { transforms: Record<string, Transform>; background: string; title: string; description: string }): void {
		for (const [id, t] of Object.entries(snapshot.transforms)) {
			const object = this.state.objects[id];
			if (object !== undefined) object.transform = { ...t };
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

export function shapeOfObject(object: CanvasObject): SolverShape {
	return {
		id: object.id,
		x: object.transform.x,
		y: object.transform.y,
		width: object.transform.width,
		height: object.transform.height,
		circle: object.clip.shape === 'circle',
		border: object.border.width
	};
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
		circle: participant.clip.shape === 'circle',
		border: AVATAR_BORDER
	};
}

export function transformFromShapeMove(transform: Transform, x: number, y: number): Transform {
	return { ...transform, x, y };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
