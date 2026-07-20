import type {
	MediaKind,
	MediaTransport,
	PeerId,
	PublicationId,
	RemoteTrack,
	TransportStats
} from './transport';

/**
 * A transport that carries nothing (AR-TRANSPORT-3).
 *
 * It exists so `MediaTransport` has TWO implementations from the day it is
 * written. An interface with one implementation is a description of that
 * implementation — `MemoryRoomStore` is the reason `RoomStore` came out clean
 * enough that a Supabase-backed store could slot in behind it, and the same
 * trick is worth repeating for the seam an SFU has to fit later.
 *
 * It also gives the rest of the system somewhere to point when there is no
 * media: a lone occupant (AR-CTRL-3), a browser that refused camera
 * permission, or a test that cares about the canvas and not about WebRTC. Those
 * callers get an object that answers every question honestly rather than a null
 * they have to defend against at every call site.
 *
 * Most methods declare no parameters at all. TypeScript lets an implementation
 * take fewer arguments than its interface, and naming arguments this class
 * ignores would either be dead identifiers or an `_`-prefix convention the lint
 * config does not recognise. The full signatures live on `MediaTransport`,
 * which is where a reader should look for them.
 *
 * Every method succeeds and does nothing. It records peers only so `stats()`
 * can report them as `closed`, which is true: there is no connection.
 */
export class NullTransport implements MediaTransport {
	// Plain collections throughout: this is a non-reactive module, nothing here
	// is rendered, and a reactive Set would be claiming otherwise.
	private readonly peers = new Set<PeerId>();
	private readonly trackHandlers = new Set<(track: RemoteTrack) => void>();
	private readonly endedHandlers = new Set<(peer: PeerId, kind: MediaKind) => void>();
	private readonly stateHandlers = new Set<(stats: TransportStats) => void>();
	private published = 0;

	addPeer(peer: PeerId): Promise<void> {
		this.peers.add(peer);
		return Promise.resolve();
	}

	removePeer(peer: PeerId): Promise<void> {
		this.peers.delete(peer);
		return Promise.resolve();
	}

	publish(): Promise<PublicationId> {
		// A real handle, so a caller that stores it and later unpublishes is
		// exercising the same code path it would against a live transport.
		this.published += 1;
		return Promise.resolve(`null-${String(this.published)}`);
	}

	unpublish(): Promise<void> {
		return Promise.resolve();
	}

	subscribe(): Promise<void> {
		return Promise.resolve();
	}

	setLayer(): Promise<void> {
		return Promise.resolve();
	}

	unsubscribe(): Promise<void> {
		return Promise.resolve();
	}

	pause(): Promise<void> {
		return Promise.resolve();
	}

	resume(): Promise<void> {
		return Promise.resolve();
	}

	stats(): Promise<readonly TransportStats[]> {
		return Promise.resolve(
			[...this.peers].map((peer) => ({
				peer,
				state: 'closed' as const,
				rttMs: null,
				outboundLossRatio: null,
				inboundLossRatio: null,
				sendBitrateBps: null,
				encoderDropRatio: null,
				// Null rather than false: "not relayed" would be a claim about a
				// connection that does not exist, and AR-COST-9 counts these.
				relayed: null
			}))
		);
	}

	onRemoteTrack(handler: (track: RemoteTrack) => void): () => void {
		this.trackHandlers.add(handler);
		return () => this.trackHandlers.delete(handler);
	}

	onTrackEnded(handler: (peer: PeerId, kind: MediaKind) => void): () => void {
		this.endedHandlers.add(handler);
		return () => this.endedHandlers.delete(handler);
	}

	onPeerState(handler: (stats: TransportStats) => void): () => void {
		this.stateHandlers.add(handler);
		return () => this.stateHandlers.delete(handler);
	}

	dispose(): void {
		this.peers.clear();
		this.trackHandlers.clear();
		this.endedHandlers.clear();
		this.stateHandlers.clear();
	}
}
