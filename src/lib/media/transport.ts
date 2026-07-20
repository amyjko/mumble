import type { Layer } from './ladder';

/**
 * The media-provider adapter (AR-TRANSPORT-10) and the seam it defines
 * (AR-TRANSPORT-3).
 *
 * One interface, implemented per transport: P2P is the first implementation, an
 * SFU is the second, and a DIFFERENT SFU is a third that changes nothing above
 * this line. The build order is emphatic that the interface comes first — "an
 * interface written after the fact is shaped by whatever leaked through it" —
 * which is why this file exists before any WebRTC does.
 *
 * **The standing rule (AR-TRANSPORT-10): no consumer of this interface may name
 * a provider.** Provider identifiers, SDKs and vendor-shaped concepts live
 * inside one implementation and nowhere else. That rule is enforced by
 * `no-provider-names.spec.ts` rather than by memory, in the same idiom as
 * `no-raw-color` and `no-raw-emoji` — it was a sentence in a document, and a
 * sentence is not a gate.
 *
 * ## The one decision worth arguing about: `publish` takes no layer
 *
 * AR-MEDIA-3 has the two transports delivering a rung differently — an SFU
 * receives every layer and forwards a chosen one (simulcast); P2P encodes each
 * peer the single layer that peer asked for. If `publish()` carried a layer,
 * this interface would be describing the P2P mechanism, and the SFU would
 * arrive as a retrofit against a shape that never fit it.
 *
 * So the SUBSCRIBER names the rung, and the implementation decides how to
 * satisfy it. Everything about how a request travels publisher-ward is internal
 * to an implementation. This is exactly the difference AR-TRANSPORT-10 exists
 * to absorb, and getting it backwards is the failure the build order warns of.
 *
 * ## What this deliberately does not expose
 *
 * `RTCPeerConnection`, SDP, ICE candidates or servers, `RTCRtpSender`, raw
 * `getStats()` dictionaries, simulcast, session/track identifiers of any
 * provider, the promotion/flip state machine, and `room_state.transport` (which
 * stays inert until V2 — if anything here branches on it, AR-TRANSPORT-3 has
 * already failed).
 *
 * Capture sits ABOVE this seam: an implementation is handed a
 * `MediaStreamTrack` and never asks for one. Whether to prompt for a camera is
 * a product decision (a lurker must not see a permission dialog), and it is
 * made by the plan, not by a transport.
 */

/** A participant id. Never a provider's idea of a peer, session or track. */
export type PeerId = string;

/** An opaque handle minted by an implementation. Do not parse it. */
export type PublicationId = string;

/**
 * `screen` is a third kind rather than a second video publication (UX-OBJ-6).
 *
 * It works because a person has at most one share, so `(peer, 'screen')` names
 * it uniquely and every one-publication-per-kind assumption below this line
 * stays true. If that ever stops holding, publications must grow real opaque
 * handles and this union is the wrong shape — see `PublicationId`.
 *
 * It is a KIND and not a flavour of video because the two differ in ways the
 * transport must act on: a share is authorized by a different holder list, and
 * it is encoded for detail rather than motion.
 *
 * `screenaudio` is the share's OWN sound — a tab's audio, not a microphone
 * (UX-OBJ-16). Same argument: one share per person, so the pair is unique. It
 * rides the SCREEN slot rather than an audio one, which is why it is a separate
 * kind from `audio` and not a second audio publication: they are authorized
 * against different holder lists, and priced for music rather than speech.
 */
export type MediaKind = 'video' | 'audio' | 'screen' | 'screenaudio';

/**
 * Connection lifecycle, normalised across transports.
 *
 * `interrupted` is deliberately distinct from `failed`: ICE disconnects
 * routinely recover, and a UI that reports "call failed" on every brief network
 * blip is lying about a state that usually resolves itself.
 */
export type PeerState = 'new' | 'connecting' | 'connected' | 'interrupted' | 'failed' | 'closed';

/**
 * The normalised stats surface. Every field is nullable because no transport
 * reports all of them at all times, and a zero would be a lie about a
 * measurement that simply is not available yet.
 */
export interface TransportStats {
	readonly peer: PeerId;
	readonly state: PeerState;
	readonly rttMs: number | null;
	readonly outboundLossRatio: number | null;
	readonly inboundLossRatio: number | null;
	readonly sendBitrateBps: number | null;
	readonly encoderDropRatio: number | null;
	/**
	 * Whether this connection is paying for a relay.
	 *
	 * AR-COST-9 calls the relay fraction "the single number worth watching
	 * early" — with a P2P MVP it is the only media spend the product carries.
	 * Null when the transport cannot tell.
	 */
	readonly relayed: boolean | null;
}

export interface RemoteTrack {
	readonly peer: PeerId;
	readonly kind: MediaKind;
	readonly stream: MediaStream;
}

export interface MediaTransport {
	/**
	 * Prepare a connection to a peer.
	 *
	 * Separate from `publish` on purpose: AR-TRANSPORT-9 wants a slot handoff
	 * pre-warmed "a beat before the visible grant", which means a connection can
	 * be established while nothing is being sent over it yet.
	 */
	addPeer(peer: PeerId): Promise<void>;
	removePeer(peer: PeerId): Promise<void>;

	/** Send a captured track. No layer — see the note at the top of this file. */
	publish(kind: MediaKind, track: MediaStreamTrack): Promise<PublicationId>;
	unpublish(publication: PublicationId): Promise<void>;

	/** Ask for a peer's track at a rung. This is where the ladder is spoken. */
	subscribe(peer: PeerId, kind: MediaKind, layer: Layer): Promise<void>;
	setLayer(peer: PeerId, kind: MediaKind, layer: Layer): Promise<void>;
	unsubscribe(peer: PeerId, kind: MediaKind): Promise<void>;

	/**
	 * Stop and resume receiving without renegotiating. A paused subscription
	 * costs no egress (AR-MEDIA-4), which is why this is not just unsubscribe.
	 */
	pause(peer: PeerId, kind: MediaKind): Promise<void>;
	resume(peer: PeerId, kind: MediaKind): Promise<void>;

	stats(): Promise<readonly TransportStats[]>;

	/** Each returns an unsubscriber, matching `RoomStore.onEphemeral`. */
	onRemoteTrack(handler: (track: RemoteTrack) => void): () => void;
	onTrackEnded(handler: (peer: PeerId, kind: MediaKind) => void): () => void;
	onPeerState(handler: (stats: TransportStats) => void): () => void;

	dispose(): void;
}
