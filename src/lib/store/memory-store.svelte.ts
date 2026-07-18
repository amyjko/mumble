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
	state = $state<RoomState>({ objects: {}, participants: {} });

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
		if (typeof localStorage === 'undefined') return { objects: {}, participants: {} };
		const raw = localStorage.getItem(this.storageKey);
		if (raw === null) return { objects: {}, participants: {} };
		const parsed = roomStateSchema.safeParse(parseJson(raw));
		if (!parsed.success) {
			console.warn('mumble: stored room state failed validation; starting fresh');
			return { objects: {}, participants: {} };
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
		}
	}

	private requireObject(id: string): CanvasObject {
		const object = this.state.objects[id];
		if (object === undefined) throw new StoreRejection('invalid', 'Unknown object');
		return object;
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
	return {
		id: participant.id,
		x: participant.location.x,
		y: participant.location.y,
		width: AVATAR_SIZE,
		height: AVATAR_SIZE,
		circle: true,
		border: AVATAR_BORDER
	};
}

export function transformFromShapeMove(transform: Transform, x: number, y: number): Transform {
	return { ...transform, x, y };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
