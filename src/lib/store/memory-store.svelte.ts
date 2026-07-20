import {
	envelopeSchema,
	mutationSchema,
	parseJson,
	roomStateSchema, freshRoomState } from '$lib/model/schemas';
import { StoreRejection } from '$lib/model/types';
import type {
	EphemeralMessage,
	Mutation,
	RoomState
} from '$lib/model/types';
import { untrack } from 'svelte';
import { applyMutation } from '$lib/model/rules';

/** Modelled network latency for the dev panel (AR-SYNC-2's revert path). */
import { docFromEncoded, mergeEncoded, noteText } from '$lib/model/ydoc';
import type { RoomStore } from './room-store';

/** Modelled network latency for the dev panel (AR-SYNC-2's revert path). */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function freshState(): RoomState {
	return freshRoomState();
}

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
	private readonly isHost: boolean;
	// Subscription plumbing, never rendered. Making it reactive (SvelteSet)
	// crashes with state_unsafe_mutation: SyncClient subscribes during its own
	// $derived construction, which would then mutate another derived's state.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- see above
	private readonly handlers = new Set<(m: EphemeralMessage) => void>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- see above
	private readonly signalHandlers = new Set<(from: string, payload: unknown) => void>();
	/** This TAB. Cross-tab signalling addresses tabs, not people. */
	private readonly clientId = crypto.randomUUID();
	/**
	 * Peers seen across tabs, this one included.
	 *
	 * `present` used to be "just me" and `onPresenceLeave` a no-op, which was
	 * honest for a store with no socket to drop but made every signalling test
	 * against it vacuous. There IS a moment a tab leaves here — `dispose` —
	 * so this announces it rather than pretending the question is unanswerable.
	 */
	private known = $state<{ endpoint: string; actor: string }[]>([]);

	/**
	 * `isHost` is supplied, never inferred. The stub has no way to know — the
	 * fact lives in a room_members row (AR-CTRL-7), and the room page reads it
	 * before constructing this. Defaulting to false keeps every existing caller
	 * honest: a store built without the fact does not get host powers.
	 */
	constructor(room: string, actorId: string, isHost = false) {
		this.actorId = actorId;
		this.isHost = isHost;
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
						// Answer with who we are, so the newcomer learns about us as
						// well: `hello` alone is one-directional.
						this.note(envelope.endpoint, envelope.actor);
						this.channel?.postMessage({
							v: 1,
							t: 'here',
							endpoint: this.clientId,
							actor: this.actorId
						});
						break;
					case 'here':
						this.note(envelope.endpoint, envelope.actor);
						break;
					case 'bye': {
						const leaving = this.known.find((e) => e.endpoint === envelope.endpoint);
						this.known = this.known.filter((e) => e.endpoint !== envelope.endpoint);
						// Announce only when their LAST tab has gone, matching the
						// server-backed store's contract.
						if (leaving !== undefined && !this.known.some((e) => e.actor === leaving.actor)) {
							for (const handler of this.leaveHandlers) handler(leaving.actor);
						}
						break;
					}
					case 'signal':
						if (envelope.to !== this.clientId) break;
						for (const handler of this.signalHandlers) handler(envelope.from, envelope.payload);
						break;
				}
			};
			this.channel.postMessage({ v: 1, t: 'hello', endpoint: this.clientId, actor: actorId });
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
			// ONE call into the rule engine (model/rules.ts). Everything the
			// commit-side gate used to do inline now lives there, so the server
			// route enforces the identical rules rather than a second copy of
			// them (AR-SYNC-3).
			//
			const outcome = applyMutation(this.state, parsed.data, {
				actorId: this.actorId,
				isHost: this.isHost
			});
			this.droppedChatMessages += outcome.droppedMessages;
			this.persistAndBroadcast();
		});
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

	/**
	 * Presence, as far as the stub can honestly report it.
	 *
	 * This store syncs over BroadcastChannel and localStorage, neither of which
	 * carries a connection: there is no socket to drop, so there is no moment at
	 * which "they left" is known. It reports the one actor it is certain about
	 * — itself — and never announces a leave.
	 *
	 * That is a real limitation, not a placeholder to fill in later. It is also
	 * why the >=2-present rule and slot reaping cannot be exercised against the
	 * stub, and why both are tested against the server-backed store.
	 */
	/** Record a peer tab, ignoring one that predates endpoint announcements. */
	private note(endpoint: string | undefined, actor: string | undefined): void {
		if (endpoint === undefined || actor === undefined) return;
		if (this.known.some((e) => e.endpoint === endpoint)) return;
		this.known = [...this.known, { endpoint, actor }];
	}

	get endpoint(): string {
		return this.clientId;
	}

	get endpoints(): readonly { readonly endpoint: string; readonly actor: string }[] {
		const self = this.actorId === '' ? [] : [{ endpoint: this.clientId, actor: this.actorId }];
		return [...self, ...this.known];
	}

	get present(): readonly string[] {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, not state
		return [...new Set(this.endpoints.map((e) => e.actor))];
	}

	sendSignal(to: string, payload: unknown): void {
		if (this.closed) return;
		this.channel?.postMessage({ v: 1, t: 'signal', to, from: this.clientId, payload });
	}

	onSignal(handler: (from: string, payload: unknown) => void): () => void {
		this.signalHandlers.add(handler);
		return () => this.signalHandlers.delete(handler);
	}

	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- see above
	private readonly leaveHandlers = new Set<(actorId: string) => void>();

	onPresenceLeave(handler: (actorId: string) => void): () => void {
		this.leaveHandlers.add(handler);
		return () => this.leaveHandlers.delete(handler);
	}

	dispose(): void {
		// Say goodbye BEFORE closing, or the message never leaves. This is the
		// moment that makes `onPresenceLeave` real here rather than a no-op: a
		// tab in this store has no socket to drop, but it does have a dispose.
		this.channel?.postMessage({ v: 1, t: 'bye', endpoint: this.clientId });
		this.closed = true;
		this.channel?.close();
		this.handlers.clear();
		this.signalHandlers.clear();
		this.leaveHandlers.clear();
	}
}

/**
 * Re-exported from model/shapes.ts, which is where they live now.
 *
 * Kept as exports here so the canvas's many import sites did not all have to
 * move in the same commit as a rule-engine extraction — two large mechanical
 * changes at once is how a behaviour-preserving refactor stops being provably
 * behaviour-preserving.
 */
export {
	participatesInCollision,
	shapeOfObject,
	shapeOfPlacer,
	shapeOfParticipant,
	outlinePoints
} from '$lib/model/shapes';
export { CHAT_LOG_LIMIT } from '$lib/model/limits';
