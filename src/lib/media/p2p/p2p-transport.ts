import type { Layer } from '$lib/media/ladder';
import type { Grant } from '$lib/media/grant';
import type { IceServer } from '$lib/server/ice';
import type {
	MediaKind,
	MediaTransport,
	PeerId,
	PublicationId,
	RemoteTrack,
	TransportStats
} from '$lib/media/transport';
import { z } from 'zod';
import { PeerConnection, parseSignal } from './connection';
import { isPolite } from './signal';
import type { PublishAuthorizer, Holders } from './authorize';

/**
 * The P2P implementation of the seam (AR-TRANSPORT-1, AR-TRANSPORT-10).
 *
 * Its job is translation. Above the seam everything speaks PEOPLE — `planMedia`
 * produces actor ids, the stage holds actor ids, a tile belongs to a person.
 * Underneath, a connection is to a TAB, because that is what has an address and
 * what perfect negotiation can order. This class owns that fan-out and is the
 * only place the difference exists.
 *
 * One person with three tabs open is three connections and one peer. That is not
 * an edge case to tolerate: it is the ordinary consequence of the store being
 * per-tab, and pretending otherwise is what makes two tabs of one person answer
 * the same offer.
 */

export interface P2PTransportOptions {
	readonly self: string;
	readonly ice: readonly IceServer[];
	readonly authorizer: PublishAuthorizer;
	/** Endpoints currently connected, and whose they are. From the store. */
	readonly endpoints: () => readonly { readonly endpoint: string; readonly actor: string }[];
	readonly send: (to: string, payload: unknown) => void;
	/** Forbid direct paths; see `ConnectionOptions.relayOnly`. */
	readonly relayOnly?: boolean;
}

/**
 * What the session route hands back, from this transport's point of view.
 *
 * Parsed HERE rather than by the session, because these are meaningful only to
 * a transport that opens peer connections — the layer above must not learn that
 * such a thing as a relay exists.
 */
const z_credentials = z.object({
	iceServers: z.array(
		z.object({
			urls: z.union([z.string(), z.array(z.string())]),
			username: z.string().optional(),
			credential: z.string().optional()
		})
	)
});

export class P2PTransport implements MediaTransport {
	private readonly options: P2PTransportOptions;
	/** Keyed by ENDPOINT. Several may share an actor. */
	private readonly connections = new Map<string, PeerConnection>();
	/** Tracks we are publishing, so a new connection starts up to date. */
	private readonly published = new Map<MediaKind, MediaStreamTrack>();
	/** What we want from each peer, so a reconnect restores it. */
	private readonly subscriptions = new Map<PeerId, Map<MediaKind, Layer | null>>();
	private readonly peers = new Set<PeerId>();

	private readonly trackHandlers = new Set<(track: RemoteTrack) => void>();
	private readonly endedHandlers = new Set<(peer: PeerId, kind: MediaKind) => void>();
	private readonly stateHandlers = new Set<(stats: TransportStats) => void>();

	private grant: Grant | undefined = undefined;
	/**
	 * Server-minted, and applied to connections opened AFTER they arrive.
	 *
	 * They were being dropped entirely until the provider-name guard exposed it:
	 * the wiring passed an empty list, which works perfectly on loopback and
	 * would have failed for the ~10-15% of real connections needing a relay
	 * (AR-TRANSPORT-8). Local coverage of that path is zero, so nothing else
	 * would have noticed.
	 */
	private ice: readonly IceServer[];
	private disposed = false;

	constructor(options: P2PTransportOptions) {
		this.options = options;
		this.ice = options.ice;
	}

	/** Take the connection credentials out of a session response. */
	useCredentials(raw: unknown): void {
		const parsed = z_credentials.safeParse(raw);
		if (!parsed.success) return;
		// Rebuilt field by field rather than assigned: under
		// `exactOptionalPropertyTypes` an optional produced by zod is
		// `string | undefined`, which is not the same type as an absent property.
		this.ice = parsed.data.iceServers.map((server) => ({
			urls: server.urls,
			...(server.username === undefined ? {} : { username: server.username }),
			...(server.credential === undefined ? {} : { credential: server.credential })
		}));
	}

	/** The grant to attach to offers. Set whenever a fresh one is issued. */
	setGrant(grant: Grant | undefined): void {
		this.grant = grant;
		for (const connection of this.connections.values()) connection.setGrant(grant);
	}

	/**
	 * The stage, pushed down on EVERY change rather than read at offer time.
	 *
	 * Revocation has to take effect without waiting for a renegotiation that may
	 * never come, so this both updates the gate and immediately stops asking a
	 * peer who no longer holds a slot to send anything. Without the second half a
	 * revoked publisher keeps streaming until something else happens to
	 * renegotiate.
	 */
	setStage(stage: Holders): void {
		this.options.authorizer.setStage(stage);
		for (const [peer, wanted] of this.subscriptions) {
			for (const kind of wanted.keys()) {
				if (this.options.authorizer.holds(peer, kind)) continue;
				this.tell(peer, (connection) => {
					connection.want(kind, null);
				});
			}
		}
	}

	/** Every live connection to a person. */
	private endpointsFor(peer: PeerId): string[] {
		return this.options
			.endpoints()
			.filter((entry) => entry.actor === peer)
			.map((entry) => entry.endpoint);
	}

	private tell(peer: PeerId, act: (connection: PeerConnection) => void): void {
		for (const endpoint of this.endpointsFor(peer)) {
			const connection = this.connections.get(endpoint);
			if (connection !== undefined) act(connection);
		}
	}

	private connect(endpoint: string, actor: PeerId): PeerConnection {
		const existing = this.connections.get(endpoint);
		if (existing !== undefined) return existing;

		const connection = new PeerConnection({
			remote: endpoint,
			actor,
			polite: isPolite(this.options.self, endpoint),
			ice: this.ice,
			...(this.options.relayOnly === true ? { relayOnly: true } : {}),
			send: (signal) => {
				this.options.send(endpoint, signal);
			},
			onTrack: (track) => {
				for (const handler of this.trackHandlers) handler(track);
			},
			onEnded: (who, kind) => {
				for (const handler of this.endedHandlers) handler(who, kind);
			},
			onState: (stats) => {
				for (const handler of this.stateHandlers) handler(stats);
			},
			authorize: (grant, kinds) =>
				this.options.authorizer.allows(grant, actor, kinds, Math.floor(Date.now() / 1000))
		});
		connection.setGrant(this.grant);
		this.connections.set(endpoint, connection);

		// A connection opened after we started publishing must catch up, or a peer
		// who joins mid-session sees nothing until the publisher happens to
		// republish.
		for (const [kind, track] of this.published) connection.send(kind, track);
		const wanted = this.subscriptions.get(actor);
		if (wanted !== undefined) {
			for (const [kind, layer] of wanted) connection.want(kind, layer);
		}
		// Establish ICE before anything is sent over it. A no-op on the polite
		// side, which waits to be offered to.
		connection.prewarm();
		return connection;
	}

	/** Inbound signal from the store, addressed to us. */
	accept(fromEndpoint: string, payload: unknown): void {
		if (this.disposed) return;
		const signal = parseSignal(payload);
		// Malformed peer traffic is dropped rather than handed on, as everywhere.
		if (signal === null) return;

		const known = this.options.endpoints().find((entry) => entry.endpoint === fromEndpoint);
		/*
		 * A signal from an endpoint that is not present is dropped.
		 *
		 * `from` is chosen by the sender and cannot be trusted, but presence is
		 * not — it comes from the channel. This does not authenticate anyone; it
		 * stops a member spraying offers at peers who never joined, which would
		 * otherwise churn a connection per message.
		 */
		if (known === undefined) return;

		const connection = this.connect(fromEndpoint, known.actor);
		void connection.accept(signal);
	}

	async addPeer(peer: PeerId): Promise<void> {
		this.peers.add(peer);
		for (const endpoint of this.endpointsFor(peer)) {
			// Skip ourselves: a tab does not connect to its own other tabs for
			// media, and our own endpoint is in the same list.
			if (endpoint === this.options.self) continue;
			this.connect(endpoint, peer);
		}
		return Promise.resolve();
	}

	async removePeer(peer: PeerId): Promise<void> {
		this.peers.delete(peer);
		this.subscriptions.delete(peer);
		this.options.authorizer.forget(peer);
		for (const endpoint of this.endpointsFor(peer)) {
			this.connections.get(endpoint)?.close();
			this.connections.delete(endpoint);
		}
		return Promise.resolve();
	}

	async publish(kind: MediaKind, track: MediaStreamTrack): Promise<PublicationId> {
		this.published.set(kind, track);
		for (const connection of this.connections.values()) connection.send(kind, track);
		// The kind IS the handle: one publication per kind is all P2P supports
		// here, and inventing an opaque id would imply otherwise.
		return Promise.resolve(kind);
	}

	/**
	 * Whether a kind is currently on the wire.
	 *
	 * Not on `MediaTransport`: nothing above the seam asks, and putting it there
	 * would invite callers to poll the transport for state the plan already
	 * owns. It sits beside `setGrant` and `setStage` as an implementation-side
	 * query, and it is what lets a test assert that stopping a share left the
	 * camera alone.
	 */
	publishing(kind: MediaKind): boolean {
		return this.published.has(kind);
	}

	async unpublish(publication: PublicationId): Promise<void> {
		/*
		 * Narrowed exhaustively, never by falling through to 'video'.
		 *
		 * This used to read `publication === 'audio' ? 'audio' : 'video'`, which
		 * was correct only while there were exactly two kinds. The moment screen
		 * shares existed it meant `unpublish('screen')` stopped the CAMERA and
		 * left the share running — a bug with no error and no failing assertion
		 * anywhere, presenting as "my video cut out when I stopped sharing".
		 *
		 * An unrecognised handle now unpublishes nothing, which is the safe half
		 * of the mistake: a stale id cannot take down a live track.
		 */
		if (
			publication !== 'video' &&
			publication !== 'audio' &&
			publication !== 'screen' &&
			publication !== 'screenaudio'
		) {
			return;
		}
		const kind: MediaKind = publication;
		this.published.delete(kind);
		for (const connection of this.connections.values()) connection.stopSending(kind);
		return Promise.resolve();
	}

	private remember(peer: PeerId, kind: MediaKind, layer: Layer | null): void {
		const wanted = this.subscriptions.get(peer) ?? new Map<MediaKind, Layer | null>();
		wanted.set(kind, layer);
		this.subscriptions.set(peer, wanted);
	}

	async subscribe(peer: PeerId, kind: MediaKind, layer: Layer): Promise<void> {
		this.remember(peer, kind, layer);
		this.tell(peer, (connection) => {
			connection.want(kind, layer);
		});
		return Promise.resolve();
	}

	async setLayer(peer: PeerId, kind: MediaKind, layer: Layer): Promise<void> {
		return this.subscribe(peer, kind, layer);
	}

	async unsubscribe(peer: PeerId, kind: MediaKind): Promise<void> {
		this.subscriptions.get(peer)?.delete(kind);
		this.tell(peer, (connection) => {
			connection.want(kind, null);
		});
		return Promise.resolve();
	}

	async pause(peer: PeerId, kind: MediaKind): Promise<void> {
		// Deliberately keeps the remembered layer: resume must restore what was
		// asked for, not fall back to a default.
		this.tell(peer, (connection) => {
			connection.want(kind, null);
		});
		return Promise.resolve();
	}

	async resume(peer: PeerId, kind: MediaKind): Promise<void> {
		const layer = this.subscriptions.get(peer)?.get(kind) ?? 'low';
		this.tell(peer, (connection) => {
			connection.want(kind, layer);
		});
		return Promise.resolve();
	}




	async stats(): Promise<readonly TransportStats[]> {
		return Promise.all([...this.connections.values()].map((connection) => connection.stats()));
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
		this.disposed = true;
		// Silent: this tab is rebuilding or leaving, and a `bye` would reach the
		// peer's next connection rather than this one.
		for (const connection of this.connections.values()) connection.close(false);
		this.connections.clear();
		this.published.clear();
		this.subscriptions.clear();
		this.trackHandlers.clear();
		this.endedHandlers.clear();
		this.stateHandlers.clear();
	}
}
