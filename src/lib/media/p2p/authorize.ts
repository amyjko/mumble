import { grantAllows, verifyGrant, type Grant } from '$lib/media/grant';
import type { MediaKind, PeerId } from '$lib/media/transport';

/**
 * The receiver-side publish gate (AR-MEDIA-2, UX-STAGE-6).
 *
 * On P2P nothing sits in the media path, so the only party in a position to
 * refuse unauthorized media is the peer being offered it. The server issues a
 * signed grant; this decides whether to answer an offer that carries one.
 *
 * Pure over injected inputs — the key and the holder lists are handed in — so
 * the whole rule is testable in node without a peer connection, a browser, or a
 * network. Everything WebRTC lives one file over.
 *
 * The honest limit, restated because it is easy to overclaim: a room in which
 * every client is patched can carry whatever it likes. This makes an
 * unauthorized publisher refused by any peer running our code, which is a real
 * property and a smaller one than "cannot publish".
 */

/** What the receiver believes the stage to be, read from its own room state. */
export interface Holders {
	readonly video: readonly string[];
	readonly audio: readonly string[];
}

const EMPTY_STAGE: Holders = { video: [], audio: [] };

export class PublishAuthorizer {
	private readonly room: string;
	/**
	 * A PROMISE, so an authorizer can exist before its key has arrived.
	 *
	 * A peer connection can be offered to within milliseconds of a page loading,
	 * which is sooner than a fetch completes. Holding the promise means such an
	 * offer waits for the key rather than being refused for want of it — and a
	 * refusal there would present as "video sometimes doesn't connect", which is
	 * the worst kind of bug to chase.
	 */
	private readonly key: Promise<CryptoKey>;
	private stage: Holders = EMPTY_STAGE;
	/**
	 * The highest grant stage accepted from each peer.
	 *
	 * Per PEER, deliberately, and never compared against the room's current
	 * version: `save_room_state` bumps that on every mutation, so a receiver
	 * comparing the two would refuse every honest grant the moment somebody
	 * dragged a note. See the note on `stage` in grant.ts.
	 */
	private readonly seen = new Map<PeerId, number>();

	constructor(room: string, key: CryptoKey | Promise<CryptoKey>) {
		this.room = room;
		this.key = Promise.resolve(key);
	}

	/**
	 * The holder lists, refreshed whenever the room's state changes.
	 *
	 * This must be called on EVERY change rather than only at offer time. A
	 * grant checked once stays accepted until the next renegotiation, which may
	 * never come — so revocation would take effect only by luck. The transport
	 * re-evaluates its live subscriptions against this.
	 */
	setStage(stage: Holders): void {
		this.stage = stage;
	}

	/** Whether this peer is authorized RIGHT NOW, independent of any grant. */
	holds(peer: PeerId, kind: MediaKind): boolean {
		return kind === 'video' ? this.stage.video.includes(peer) : this.stage.audio.includes(peer);
	}

	/**
	 * Whether to answer an offer from `peer` that wants to send `kinds`.
	 *
	 * Every clause has to hold, and they are different questions:
	 *   1. the signature verifies — the control plane really issued this;
	 *   2. it names this room and this peer, and covers the kind;
	 *   3. it has not expired;
	 *   4. it has not regressed behind a grant already seen from this peer;
	 *   5. the receiver's OWN holder list contains them.
	 *
	 * (5) is what makes authorization current rather than merely genuine. The
	 * list is read from Postgres under RLS, never taken from the peer, so a
	 * grant captured before a revoke fails here within one broadcast round trip
	 * instead of lingering for the rest of its TTL.
	 */
	async allows(
		grant: Grant | undefined,
		peer: PeerId,
		kinds: readonly MediaKind[],
		nowSeconds: number
	): Promise<boolean> {
		// An offer that adds no sending track needs no grant — that is a receiver
		// asking to be sent to, or a pre-warm with nothing on it yet.
		if (kinds.length === 0) return true;
		if (grant === undefined) return false;

		const body = await verifyGrant(grant, await this.key, nowSeconds).catch(() => null);
		if (body === null) return false;

		const seenStage = this.seen.get(peer) ?? 0;
		for (const kind of kinds) {
			if (!grantAllows(body, { room: this.room, peer, kind, seenStage })) return false;
			if (!this.holds(peer, kind)) return false;
		}

		// Recorded only after every clause passed, so a refused grant cannot
		// raise the bar for the honest one that follows it.
		this.seen.set(peer, Math.max(seenStage, body.stage));
		return true;
	}

	/** Forget a peer entirely, so a rejoin starts clean. */
	forget(peer: PeerId): void {
		this.seen.delete(peer);
	}
}
