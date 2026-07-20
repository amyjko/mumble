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

	/**
	 * Who is CONNECTED right now, by actor id.
	 *
	 * Deliberately not `state.participants`: a participant row says "this person
	 * joined" and outlives the tab that wrote it, while this says "this person
	 * is here". The difference is a closed laptop, and it matters twice over —
	 * AR-CTRL-3's >=2-present rule is about people present rather than rows, and
	 * a holder who vanishes has to be reaped or their slot is held by nobody.
	 */
	readonly present: readonly string[];

	/**
	 * An actor's LAST connection went. Returns an unsubscriber.
	 *
	 * On the seam rather than on one implementation, because the consumer that
	 * acts on it (a host reaping an absent holder) may not name a backend — the
	 * standing rule at the top of this file. An implementation with no liveness
	 * signal may simply never call the handler.
	 */
	onPresenceLeave(handler: (actorId: string) => void): () => void;

	/**
	 * This tab's own address. Stable for the store's lifetime.
	 *
	 * A third traffic class, addressed rather than broadcast, because WebRTC
	 * signalling concerns exactly two parties: an offer, an answer, and a burst
	 * of candidates that nobody else has any business reading.
	 *
	 * Addressed by ENDPOINT (a tab) rather than by actor (a person), and the
	 * distinction is load-bearing rather than fastidious. Perfect negotiation
	 * needs a total order over the two sides of one connection to decide which
	 * yields on a collision; two tabs of one person share an actor id, so
	 * `self < peer` ties and both tabs answer the same offer, each with a
	 * competing answer for a single connection. Endpoints are unique, so the
	 * comparison is total.
	 */
	readonly endpoint: string;

	/** Every connected tab, and whose it is. `present` is the distinct actors. */
	readonly endpoints: readonly { readonly endpoint: string; readonly actor: string }[];

	/**
	 * Send to ONE endpoint. Fire-and-forget, like `sendEphemeral`.
	 *
	 * The payload is `unknown` on purpose: the store is a relay and never reads
	 * it. That keeps SDP out of `model/schemas.ts` entirely — the media layer
	 * owns its own vocabulary and parses at the boundary, and the store stays a
	 * thing that moves bytes between tabs without knowing what they mean.
	 *
	 * What arrives is NOT authenticated. A backend can prove the sender belongs
	 * to the room; it cannot prove they are who the message says they are, so
	 * `from` is advisory and anything trusting it must verify separately. That
	 * is what the signed publish grant is for.
	 */
	sendSignal(to: string, payload: unknown): void;

	/** Subscribe to signals addressed to this endpoint. Returns an unsubscriber. */
	onSignal(handler: (from: string, payload: unknown) => void): () => void;

	dispose(): void;
}
