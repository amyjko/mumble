import type { EphemeralMessage, Mutation, RoomState } from '$lib/model/types';

/**
 * The seam (the third application of AR-TRANSPORT-10's provider-neutrality
 * idiom, after transport and host): the canvas talks to this interface and
 * nothing else. MemoryRoomStore is the first implementation; the
 * Supabase-backed store is the second and swaps in without touching any
 * consumer. No consumer may name a backend.
 *
 * The shape mirrors AR-SYNC-1's state classes:
 *  - `commit`      — persisted shared state. Resolves on authoritative
 *                    confirmation, rejects (StoreRejection) on denial; the
 *                    optimistic layer (AR-SYNC-2) reverts on rejection.
 *  - `sendEphemeral`/`onEphemeral` — ephemeral shared traffic (drag deltas),
 *                    throttled at the call site to ~15–20 Hz (AR-BACKEND-5),
 *                    never persisted, delivered to peers only.
 *  - local-only state (camera, selection) never passes through the store.
 */
export interface RoomStore {
	/** Reactive room snapshot; implementations back this with $state. */
	readonly state: RoomState;
	commit(mutation: Mutation): Promise<void>;
	sendEphemeral(message: EphemeralMessage): void;
	/** Subscribe to peers' ephemeral traffic. Returns an unsubscriber. */
	onEphemeral(handler: (message: EphemeralMessage) => void): () => void;
	dispose(): void;
}
