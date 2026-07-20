import type { Layer } from '$lib/media/ladder';
import type { IceServer } from '$lib/server/ice';
import type { MediaKind, PeerId, PeerState, RemoteTrack, TransportStats } from '$lib/media/transport';
import type { Grant } from '$lib/media/grant';
import { encodingFor } from './encode';
import { normaliseStats, type StatsSample } from './stats';
import { signalSchema, type Signal } from './signal';

/**
 * One connection to one remote TAB (AR-TRANSPORT-1).
 *
 * The only file in the project that owns an `RTCPeerConnection`, which is what
 * `no-provider-names.spec.ts` enforces: everything above the seam speaks peers,
 * kinds and rungs, and nothing above it knows SDP exists.
 *
 * ## Perfect negotiation
 *
 * Both sides may want to renegotiate at once — two people unmuting together is
 * enough. Rather than inventing a lock, one side is designated POLITE and rolls
 * back its own offer when it collides with an incoming one; the impolite side
 * ignores the collision and presses on. Exactly one of them must yield, which is
 * why the roles come from comparing endpoint ids (see `isPolite`) rather than
 * from anything either side chooses.
 *
 * ## The gate
 *
 * An inbound offer that would add a sending track is answered ONLY if the
 * authorizer agrees. The kinds it is judged on are read from the transceivers
 * the browser derived from the offer, never from a field the sender filled in —
 * a peer claiming to send nothing while offering a video track would otherwise
 * authorize itself trivially.
 */

export interface ConnectionOptions {
	/** The remote TAB. Connections are per-endpoint; peers are per-person. */
	readonly remote: string;
	/** Whose tab it is. What the seam above reports as the peer. */
	readonly actor: PeerId;
	readonly polite: boolean;
	readonly ice: readonly IceServer[];
	readonly send: (signal: Signal) => void;
	readonly onTrack: (track: RemoteTrack) => void;
	readonly onEnded: (peer: PeerId, kind: MediaKind) => void;
	readonly onState: (stats: TransportStats) => void;
	/** Returns false to refuse an offer outright: no answer, connection closed. */
	readonly authorize: (grant: Grant | undefined, kinds: readonly MediaKind[]) => Promise<boolean>;
}

/** Lib.dom types these as `RTCIceServer`; the shape is identical and W3C. */
function toRtcIceServers(servers: readonly IceServer[]): RTCIceServer[] {
	return servers.map((server) => ({
		urls: server.urls,
		...(server.username === undefined ? {} : { username: server.username }),
		...(server.credential === undefined ? {} : { credential: server.credential })
	}));
}

export class PeerConnection {
	private readonly options: ConnectionOptions;
	private readonly pc: RTCPeerConnection;
	private readonly senders = new Map<MediaKind, RTCRtpSender>();
	/** Capture width per kind, so a rung can be expressed as a downscale. */
	private readonly captureWidth = new Map<MediaKind, number>();
	/** What each subscriber asked us to send. Re-applied after renegotiation. */
	private readonly wanted = new Map<MediaKind, Layer | null>();
	private readonly announced = new Set<MediaKind>();

	private makingOffer = false;
	/**
	 * Whether one negotiation has completed.
	 *
	 * Startup glare is avoided by CONSTRUCTION rather than survived. The impolite
	 * side always pre-warms, so if the polite side also offers at t=0 the two
	 * collide before either has gathered a candidate — and a polite peer that
	 * rolls back at that moment was measured never emitting a single ICE
	 * candidate afterwards, negotiating media and then stalling silently forever.
	 *
	 * So the polite side simply does not open the conversation. It holds any
	 * pending offer until the first exchange settles, which costs nothing because
	 * the impolite side is already offering. Genuine mid-session glare — two
	 * people unmuting together — still happens and is still resolved by rollback,
	 * but by then ICE is established and a rollback no longer needs to re-gather.
	 */
	private negotiatedOnce = false;
	private offerPending = false;
	private ignoreOffer = false;
	private closed = false;
	private sample: StatsSample | null = null;
	/** The grant to attach to our next offer, if we are publishing. */
	private grant: Grant | undefined = undefined;

	/**
	 * Candidates that arrived before the description they belong to.
	 *
	 * Not a theoretical ordering concern. `addIceCandidate` REJECTS before a
	 * remote description exists, and on one machine ICE completes so fast that
	 * the race almost never shows — so this is exactly the class of bug that
	 * passes locally forever and fails on a real network. There is a unit test
	 * for it precisely because loopback will not produce it.
	 */
	private readonly pendingCandidates: RTCIceCandidateInit[] = [];

	/**
	 * Tracks received but not yet authorized.
	 *
	 * `ontrack` fires during `setRemoteDescription`, which is BEFORE the gate can
	 * run — so a naive implementation hands the application media it is about to
	 * refuse. Closing the connection afterwards does not unsee it: the consumer
	 * already has a live MediaStream and could render it. The keystone test
	 * caught this by asserting no track arrived, and one had.
	 *
	 * So tracks are held here and released only once `authorize` has said yes.
	 */
	private readonly heldTracks: RemoteTrack[] = [];
	private gatePassed = false;

	constructor(options: ConnectionOptions) {
		this.options = options;
		this.pc = new RTCPeerConnection({ iceServers: toRtcIceServers(options.ice) });

		this.pc.onnegotiationneeded = () => {
			void this.makeOffer();
		};

		this.pc.onicecandidate = (event) => {
			const candidate = event.candidate;
			if (candidate === null) return;
			// Sent one at a time rather than batched: a candidate held back is a
			// connection that takes longer to establish, and AR-BACKEND-5's budget
			// is about drag streams rather than a handful of frames at setup. The
			// schema accepts a batch so a future coalescer needs no wire change.
			this.options.send({
				kind: 'candidates',
				items: [
					{
						candidate: candidate.candidate,
						sdpMid: candidate.sdpMid,
						sdpMLineIndex: candidate.sdpMLineIndex,
						usernameFragment: candidate.usernameFragment
					}
				]
			});
		};

		this.pc.ontrack = (event) => {
			const track = event.track;
			const kind: MediaKind = track.kind === 'audio' ? 'audio' : 'video';
			const stream = event.streams[0] ?? new MediaStream([track]);
			const arrival: RemoteTrack = { peer: this.options.actor, kind, stream };
			if (this.gatePassed) {
				this.options.onTrack(arrival);
			} else {
				this.heldTracks.push(arrival);
			}
			track.onended = () => {
				this.options.onEnded(this.options.actor, kind);
			};
		};

		this.pc.onconnectionstatechange = () => {
			void this.report();
		};
		/*
		 * PRE-WARM (AR-TRANSPORT-9).
		 *
		 * "Taking a slot pre-warms the incoming publisher's connection a beat
		 * before the visible grant" — which requires ICE to be established while
		 * nothing is being sent. But `onnegotiationneeded` only fires when there
		 * is something to negotiate, so a connection with no tracks would sit
		 * idle until the first publish and then pay the full setup cost at
		 * exactly the moment somebody is trying to be seen.
		 *
		 * An empty data channel is enough to trigger negotiation and gather
		 * candidates. Only the impolite side opens it, for the same reason only
		 * one side offers first: two simultaneous offers is the collision the
		 * politeness rule exists to resolve, and provoking one at startup is
		 * gratuitous.
		 */
		if (!options.polite) {
			this.pc.createDataChannel('prewarm');
		}

		this.pc.oniceconnectionstatechange = () => {
			/*
			 * An ICE restart on failure rather than surrender. Broadcast is not an
			 * ordered reliable transport — a dropped candidate frame stalls a
			 * connection silently — and networks change under people. Only the
			 * impolite side restarts, for the same reason only one side offers
			 * first: two simultaneous restarts is the collision this design exists
			 * to avoid.
			 */
			if (this.pc.iceConnectionState === 'failed' && !this.options.polite && !this.closed) {
				this.pc.restartIce();
			}
			void this.report();
		};
	}

	/** Normalised lifecycle. `interrupted` is not `failed` — blips recover. */
	private get peerState(): PeerState {
		if (this.closed) return 'closed';
		switch (this.pc.connectionState) {
			case 'new':
				return 'new';
			case 'connecting':
				return 'connecting';
			case 'connected':
				return 'connected';
			case 'disconnected':
				return 'interrupted';
			case 'failed':
				return 'failed';
			case 'closed':
				return 'closed';
			default:
				return 'new';
		}
	}

	private async report(): Promise<void> {
		this.options.onState(await this.stats());
	}

	/** Attach to every subsequent offer. Set before publishing. */
	setGrant(grant: Grant | undefined): void {
		this.grant = grant;
	}

	/** Send whatever `setLocalDescription` produced. */
	private publishDescription(): void {
		const description = this.pc.localDescription;
		if (description === null) return;
		this.options.send({
			kind: 'description',
			type: description.type === 'answer' ? 'answer' : 'offer',
			sdp: description.sdp,
			...(this.grant === undefined ? {} : { grant: this.grant })
		});
	}

	/**
	 * Make an OFFER. `makingOffer` brackets this and nothing else.
	 *
	 * Answering must not set it, and conflating the two is not cosmetic: the flag
	 * feeds the collision test, so a peer that raised it while answering reported
	 * a glare that was not happening and then stalled without ever gathering
	 * candidates. That is precisely what this did, and the trace showed it as
	 * `offer | answer | offer` with no candidates and no connection.
	 */
	private async makeOffer(): Promise<void> {
		if (this.closed) return;
		if (this.options.polite && !this.negotiatedOnce) {
			// Held, not dropped: replayed the moment the first exchange settles.
			this.offerPending = true;
			return;
		}
		try {
			this.makingOffer = true;
			await this.pc.setLocalDescription();
			this.publishDescription();
		} finally {
			this.makingOffer = false;
		}
	}

	/** Answer an offer already set as the remote description. */
	private async answer(): Promise<void> {
		if (this.closed) return;
		await this.pc.setLocalDescription();
		this.publishDescription();
	}

	/** Publish a track to this peer. The transceiver is created sendonly. */
	send(kind: MediaKind, track: MediaStreamTrack): void {
		if (this.closed) return;
		const width = track.getSettings().width;
		this.captureWidth.set(kind, width ?? 0);

		const existing = this.senders.get(kind);
		if (existing !== undefined) {
			void existing.replaceTrack(track);
			this.applyWanted(kind);
			return;
		}
		const transceiver = this.pc.addTransceiver(track, { direction: 'sendonly' });
		this.senders.set(kind, transceiver.sender);
		this.applyWanted(kind);
	}

	stopSending(kind: MediaKind): void {
		const sender = this.senders.get(kind);
		if (sender === undefined) return;
		void sender.replaceTrack(null);
		// The transceiver stays: reusing it on the next publish avoids a
		// renegotiation that would otherwise cost a round trip at exactly the
		// moment someone is trying to be seen.
		this.applyWanted(kind, null);
	}

	/**
	 * A subscriber naming the rung it wants, applied WITHOUT renegotiating.
	 *
	 * `setParameters` needs no SDP exchange, so subscribe, setLayer, pause and
	 * unsubscribe are all a single message and a parameter change — none of them
	 * disturbs the connection.
	 */
	private applyWanted(kind: MediaKind, override?: Layer | null): void {
		const sender = this.senders.get(kind);
		if (sender === undefined) return;
		const layer = override === undefined ? (this.wanted.get(kind) ?? 'med') : override;
		if (override !== undefined) this.wanted.set(kind, override);

		const parameters = sender.getParameters();
		const encoding = encodingFor(kind, layer, this.captureWidth.get(kind) ?? 0);
		// `encodings` can be empty before the first negotiation; writing into an
		// empty array is ignored by the browser, so seed one.
		const encodings = parameters.encodings.length > 0 ? parameters.encodings : [{}];
		parameters.encodings = encodings.map((existing) => ({
			...existing,
			active: encoding.active,
			...(encoding.maxBitrate === undefined ? {} : { maxBitrate: encoding.maxBitrate }),
			...(encoding.maxFramerate === undefined ? {} : { maxFramerate: encoding.maxFramerate }),
			...(encoding.scaleResolutionDownBy === undefined
				? {}
				: { scaleResolutionDownBy: encoding.scaleResolutionDownBy })
		}));
		void sender.setParameters(parameters);
	}

	/** Tell the PUBLISHER what we want from them. */
	want(kind: MediaKind, layer: Layer | null): void {
		if (this.closed) return;
		this.options.send({ kind: 'want', media: kind, layer });
	}

	/** What the remote is proposing to SEND us, read from the browser's own view. */
	private incomingKinds(): MediaKind[] {
		const kinds = new Set<MediaKind>();
		for (const transceiver of this.pc.getTransceivers()) {
			// After setRemoteDescription, a remote `sendonly` shows locally as
			// `recvonly`. Reading it here rather than trusting a declared field is
			// the point: a peer could claim to send nothing and offer a track.
			if (transceiver.direction !== 'recvonly' && transceiver.direction !== 'sendrecv') continue;
			const track = transceiver.receiver.track;
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- absent mid-negotiation in some browsers
			if (track === null || track === undefined) continue;
			kinds.add(track.kind === 'audio' ? 'audio' : 'video');
		}
		return [...kinds];
	}

	/** Everything a peer sends arrives here, already parsed by the caller. */
	async accept(signal: Signal): Promise<void> {
		if (this.closed) return;

		if (signal.kind === 'bye') {
			this.close();
			return;
		}

		if (signal.kind === 'want') {
			this.applyWanted(signal.media, signal.layer);
			return;
		}

		if (signal.kind === 'candidates') {
			for (const item of signal.items) {
				const candidate: RTCIceCandidateInit = {
					candidate: item.candidate,
					sdpMid: item.sdpMid,
					sdpMLineIndex: item.sdpMLineIndex,
					usernameFragment: item.usernameFragment
				};
				if (this.pc.remoteDescription === null) {
					this.pendingCandidates.push(candidate);
					continue;
				}
				try {
					await this.pc.addIceCandidate(candidate);
				} catch {
					// A candidate refused after a rollback is expected, not an error.
					if (!this.ignoreOffer) throw new Error('candidate refused');
				}
			}
			return;
		}

		/*
		 * A description. Perfect negotiation, in the canonical form.
		 *
		 * The collision test is `makingOffer || signalingState !== 'stable'`, and
		 * it is deliberately the SIMPLE version. I first wrote the older variant
		 * that also tracks `settingRemoteAnswerPending`, mixed the two, and
		 * produced a peer that answered its own glare and then never gathered a
		 * single ICE candidate.
		 */
		const isOffer = signal.type === 'offer';
		const collision =
			isOffer && (this.makingOffer || this.pc.signalingState !== 'stable');

		this.ignoreOffer = !this.options.polite && collision;
		if (this.ignoreOffer) return;

		// Rollback is implicit: setting a remote offer while a local one is
		// pending rolls ours back.
		await this.pc.setRemoteDescription({ type: isOffer ? 'offer' : 'answer', sdp: signal.sdp });

		// Candidates that outran their description.
		const buffered = this.pendingCandidates.splice(0, this.pendingCandidates.length);
		for (const candidate of buffered) {
			try {
				await this.pc.addIceCandidate(candidate);
			} catch {
				// Stale after a rollback; the peer will send more.
			}
		}

		if (!isOffer) {
			// An answer returns us to stable: the first exchange is done, and any
			// offer the polite side held back may now go.
			this.settle();
			return;
		}

		/*
		 * The gate. Judged on what the browser derived from the SDP, so a peer
		 * cannot authorize itself by understating what it is sending.
		 *
		 * Refusal is silent and total: no answer is produced, so no media path is
		 * ever established, and the connection is closed rather than left half
		 * open for a retry to sneak through.
		 */
		const kinds = this.incomingKinds();
		if (!(await this.options.authorize(signal.grant, kinds))) {
			// Nothing held is ever released: refusing means the application never
			// sees the media at all, not that it sees it and is told to stop.
			this.heldTracks.length = 0;
			this.close();
			return;
		}

		this.gatePassed = true;
		for (const held of this.heldTracks.splice(0, this.heldTracks.length)) {
			this.options.onTrack(held);
		}

		await this.answer();
		// A subscriber's standing preferences survive renegotiation; without this
		// a peer that renegotiates silently reverts to the default rung.
		for (const kind of this.wanted.keys()) this.applyWanted(kind);
		this.settle();
	}

	/** One exchange has completed; release anything the polite side held. */
	private settle(): void {
		this.negotiatedOnce = true;
		if (!this.offerPending) return;
		this.offerPending = false;
		void this.makeOffer();
	}

	async stats(): Promise<TransportStats> {
		if (this.closed) {
			return normaliseStats(this.options.actor, 'closed', [], this.sample).stats;
		}
		const report = await this.pc.getStats();
		// Laundered to `unknown` here; `stats.ts` parses. `getStats()` entries are
		// `any` in lib.dom and `as` is banned.
		const entries: unknown[] = [];
		report.forEach((entry: unknown) => {
			entries.push(entry);
		});
		const result = normaliseStats(this.options.actor, this.peerState, entries, this.sample);
		this.sample = result.sample;
		return result.stats;
	}

	/**
	 * How many candidates are waiting for a remote description.
	 *
	 * Exposed for one test, and the reason is worth stating: on loopback the
	 * CONSEQUENCE of losing early candidates cannot be observed, because ICE
	 * learns peer-reflexive candidates from incoming connectivity checks and
	 * connects anyway. A black-box test of this passes with the buffer removed —
	 * I wrote two before checking, and both were vacuous. So the mechanism is
	 * asserted directly instead of its effect.
	 */
	get bufferedCandidateCount(): number {
		return this.pendingCandidates.length;
	}

	/** Announce a track we already told the seam about, so it is not repeated. */
	hasAnnounced(kind: MediaKind): boolean {
		return this.announced.has(kind);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.options.send({ kind: 'bye' });
		} catch {
			// A closing connection cannot be told about a failure to say goodbye.
		}
		this.pc.close();
		this.options.onState(normaliseStats(this.options.actor, 'closed', [], this.sample).stats);
	}
}

/** Parse an inbound payload at the boundary. Null for anything malformed. */
export function parseSignal(payload: unknown): Signal | null {
	const parsed = signalSchema.safeParse(payload);
	return parsed.success ? parsed.data : null;
}
