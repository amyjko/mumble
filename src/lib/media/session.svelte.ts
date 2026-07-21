import { z } from 'zod';
import type { RoomStore } from '$lib/store/room-store';
import { stage } from '$lib/model/rules';
import { grantSchema, type Grant } from './grant';
import { planMedia, type MediaPlan, type TileSize } from './plan';
import { Capture, ScreenCapture } from './capture';
import type { MediaKind, MediaTransport, PeerId, RemoteTrack } from './transport';
import { NullTransport } from './null-transport';

/**
 * What turns a plan into a running session (AR-CTRL-3, AR-TRANSPORT-9).
 *
 * `planMedia` decides WHAT should be true; this makes it so, and the split is
 * the point — the deciding is pure and exhaustively tested in node, and this
 * layer only diffs a desired state against a live one. It is also the first and
 * only caller of `/api/rooms/[room]/media/session`, which until now had tests
 * and no client.
 *
 * Nothing here names a transport. The implementation is injected, so the SFU
 * that replaces it in V2 changes this file not at all — and `NullTransport` is
 * the default, which means a page that never establishes a session behaves
 * exactly as it did before any of this existed.
 */

/*
 * Only the grant is read here, and that is a layering decision rather than
 * laziness.
 *
 * The response also carries connection credentials, which are meaningful only
 * to a particular transport — an SFU would want something else entirely. Naming
 * them above the seam would make this file a consumer that knows what is behind
 * it, and `no-provider-names.spec.ts` caught exactly that when I tried. So the
 * raw body goes to whoever wired the transport, which parses it in a place
 * allowed to know.
 */
const sessionSchema = z.object({ grant: grantSchema });

/** Re-asked before it lapses; the server's TTL is 120s. */
const REFRESH_BEFORE_EXPIRY_MS = 30_000;

export interface SessionOptions {
	readonly store: RoomStore;
	readonly roomName: string;
	readonly self: PeerId;
	/** Injected so this file names no transport. Defaults to doing nothing. */
	readonly transport?: MediaTransport;
	readonly onRemoteTrack?: (track: RemoteTrack) => void;
	readonly onTrackEnded?: (peer: PeerId, kind: MediaKind) => void;
	/**
	 * Told when a fresh grant arrives, and when the stage changes.
	 *
	 * Callbacks rather than methods reached for on the transport, because
	 * neither is on `MediaTransport` — a session that called
	 * `transport.setGrant()` would be a consumer of the seam knowing which
	 * implementation is behind it, which is the one thing AR-TRANSPORT-10
	 * forbids. The site that constructs a P2P transport wires these; an SFU
	 * would wire them to something else or not at all.
	 */
	readonly onGrant?: (grant: Grant) => void;
	/** The whole session response, for the transport to take what it needs. */
	readonly onCredentials?: (raw: unknown) => void;
	readonly onStage?: (holders: { video: string[]; audio: string[]; screen: string[] }) => void;
	/**
	 * The BROWSER ended this person's screen share — its own "Stop sharing" bar.
	 *
	 * No state changed anywhere, so a reconcile pass would never notice. The
	 * wiring site commits `stop_screenshare` in response, which releases the slot
	 * and deletes the object.
	 */
	readonly onScreenEnded?: () => void;
	/**
	 * Who the active-speaker cap admits right now (AR-MEDIA-6, UX-STAGE-5).
	 *
	 * A GETTER rather than a value, because the selection changes several times
	 * a second as levels arrive and a session constructed with a snapshot would
	 * gate on whoever was loudest when the room opened.
	 *
	 * Supplied by the wiring site, which is the only place that has both the
	 * stage and the peers' broadcast levels. The session does not compute it —
	 * selection has one home (`model/stage.ts`), and a second copy here is how a
	 * publisher and its listeners would come to disagree about who is audible.
	 */
	readonly activeSpeakers?: () => readonly PeerId[];
}

export class MediaSession {
	private readonly options: SessionOptions;
	private readonly transport: MediaTransport;
	private readonly capture = new Capture();
	private readonly screenCapture = new ScreenCapture();
	/** Whether the screen track is currently on the wire. */
	private publishedScreen = false;
	/** ...and its sound, which is separately optional (UX-OBJ-16). */
	private publishedScreenAudio = false;

	private applied: MediaPlan | null = null;
	private grant: Grant | null = null;
	private grantExpiresAtMs = 0;
	private disposed = false;
	/** Set while a reconcile is in flight, so plans queue instead of racing. */
	private busy = false;
	private again = false;
	/**
	 * Re-ask for a grant the server refused.
	 *
	 * The client applies a slot optimistically, so for a moment its own state
	 * says "I hold video" while the server's does not — and the server is right,
	 * because it is the only one that decides. Asking in that window earns a
	 * legitimate 403.
	 *
	 * The bug was not the 403; it was that nothing ever asked again. A reconcile
	 * only runs when its inputs change, and by then they already had, so a
	 * publisher who lost that race stayed silent forever with the UI cheerfully
	 * showing them as a holder. Bounded, and only while capture is still wanted.
	 */
	private grantRetry: ReturnType<typeof setTimeout> | null = null;
	private grantAttempts = 0;

	/** Live connection count, for the document attribute tests read. */
	connected = $state(0);
	/**
	 * Your own camera, so you can see yourself (UX-AV-1).
	 *
	 * The same stream the transport is publishing, rendered locally — a
	 * self-view is not a peer connection to yourself, and building one would be
	 * a comically expensive way to look in a mirror.
	 */
	localVideo = $state<MediaStream | null>(null);
	/**
	 * The browser refused this person's camera (UX-AV-3).
	 *
	 * Distinct from "camera off": they hold the slot and are trying to be seen.
	 * Without surfacing it their tile is simply blank, which looks like a bug in
	 * the room rather than a permission they withheld a moment ago.
	 */
	cameraDenied = $state(false);

	/**
	 * Whether our own audio is currently withheld by the active-speaker cap
	 * (AR-MEDIA-6). Tracked so the gate is acted on when it changes rather than
	 * re-applied on every reconcile pass.
	 */
	private audioGated = false;

	/**
	 * Our own microphone track while one is open (AR-MEDIA-6).
	 *
	 * Stays non-null while gated — that is the point. The cap withholds the
	 * publication, not the capture, so this remains measurable and a gated
	 * speaker can still be heard (by their own browser) to start talking.
	 */
	localAudio = $state<MediaStreamTrack | null>(null);
	/**
	 * Your own screen, so you can see what you are showing (UX-OBJ-6).
	 *
	 * Same reasoning as `localVideo`: a self-view is not a peer connection to
	 * yourself. It matters more here than for a camera — people check their own
	 * share to confirm they picked the right window.
	 */
	localScreen = $state<MediaStream | null>(null);

	constructor(options: SessionOptions) {
		this.options = options;
		this.transport = options.transport ?? new NullTransport();

		if (options.onScreenEnded !== undefined) {
			this.screenCapture.onEnded(options.onScreenEnded);
		}
		// Cleared locally too: the self-view must go the moment the browser's own
		// "Stop sharing" is pressed, without waiting for a mutation to round-trip.
		this.screenCapture.onEnded(() => {
			this.localScreen = null;
		});

		/*
		 * The share's sound ending on its own (UX-OBJ-16) — switching which tab is
		 * shared, most often.
		 *
		 * Handled here rather than by the reconcile loop for the same reason
		 * `onEnded` is: NO plan input changes, so a pass would never run, and if
		 * one did it would see the same stage it saw before. The track simply has
		 * to be taken off the wire when it dies. The picture is untouched.
		 */
		this.screenCapture.onAudioEnded(() => {
			if (!this.publishedScreenAudio) return;
			this.publishedScreenAudio = false;
			void this.transport.unpublish('screenaudio');
		});

		if (options.onRemoteTrack !== undefined) {
			this.transport.onRemoteTrack(options.onRemoteTrack);
		}
		if (options.onTrackEnded !== undefined) {
			this.transport.onTrackEnded(options.onTrackEnded);
		}
		// Recounted from `stats()` rather than incremented per event: a state
		// change tells us one connection moved, not how many are up.
		this.transport.onPeerState(() => {
			void this.countConnections();
		});
	}

	private async countConnections(): Promise<void> {
		const all = await this.transport.stats();
		this.connected = all.filter((s) => s.state === 'connected').length;
	}

	/**
	 * Ask the control plane whether we may publish, and for ICE credentials.
	 *
	 * A 403 or 409 is a normal answer, not a failure: it means "you hold no
	 * slot" or "nobody else is here", both of which are ordinary states of a
	 * room. Only a grant is worth keeping.
	 */
	private async refreshGrant(): Promise<void> {
		const response = await fetch(`/api/rooms/${this.options.roomName}/media/session`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		});
		if (!response.ok) {
			this.grant = null;
			this.grantExpiresAtMs = 0;
			return;
		}
		const body: unknown = await response.json();
		const parsed = sessionSchema.safeParse(body);
		if (!parsed.success) {
			this.grant = null;
			return;
		}
		this.grant = parsed.data.grant;
		this.options.onCredentials?.(body);
		// Refreshed early rather than on expiry: a grant that lapses mid-session
		// makes the next renegotiation fail, and the failure would look like a
		// network problem.
		this.grantExpiresAtMs = Date.now() + 120_000 - REFRESH_BEFORE_EXPIRY_MS;
	}

	private scheduleGrantRetry(
		tiles: ReadonlyMap<PeerId, TileSize>,
		screenTiles: ReadonlyMap<PeerId, TileSize>
	): void {
		if (this.grantRetry !== null || this.disposed) return;
		// Bounded: a participant who genuinely holds nothing must not poll the
		// control plane for the rest of the meeting.
		if (this.grantAttempts >= 5) return;
		this.grantAttempts += 1;
		this.grantRetry = setTimeout(() => {
			this.grantRetry = null;
			void this.reconcile(tiles, screenTiles);
		}, 1_000);
	}

	private clearGrantRetry(): void {
		this.grantAttempts = 0;
		if (this.grantRetry === null) return;
		clearTimeout(this.grantRetry);
		this.grantRetry = null;
	}

	private get grantIsFresh(): boolean {
		return this.grant !== null && Date.now() < this.grantExpiresAtMs;
	}

	/**
	 * Bring the live session in line with what the plan wants.
	 *
	 * Serialized rather than concurrent: two reconciles interleaving would
	 * publish and unpublish the same track, and the second would win by accident.
	 */
	async reconcile(
		tiles: ReadonlyMap<PeerId, TileSize>,
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- an empty default, never mutated
		screenTiles: ReadonlyMap<PeerId, TileSize> = new Map()
	): Promise<void> {
		if (this.disposed) return;
		if (this.busy) {
			this.again = true;
			return;
		}
		this.busy = true;
		try {
			await this.apply(tiles, screenTiles);
		} finally {
			this.busy = false;
			if (this.again) {
				this.again = false;
				void this.reconcile(tiles, screenTiles);
			}
		}
	}

	private async apply(
		tiles: ReadonlyMap<PeerId, TileSize>,
		screenTiles: ReadonlyMap<PeerId, TileSize>
	): Promise<void> {
		const state = this.options.store.state;
		const plan = planMedia({
			self: this.options.self,
			stage: stage(state),
			present: this.options.store.present,
			muted: state.participants[this.options.self]?.muted ?? false,
			tiles,
			screenTiles,
			activeSpeakers: this.options.activeSpeakers?.()
		});

		// The stage is pushed down on every pass, which is what makes revocation
		// take effect without waiting for a renegotiation.
		this.pushStage();

		const previous = this.applied;
		this.applied = plan;

		/*
		 * Peers: connect before publishing, which IS the pre-warm
		 * (AR-TRANSPORT-9).
		 *
		 * `addPeer` is called for EVERY wanted peer on every pass, not only for
		 * newly wanted ones, and that is a correctness fix rather than sloppiness.
		 * Adding a peer whose endpoints are not yet known creates no connection —
		 * there is nothing to connect to — and skipping it thereafter because it
		 * "already exists" left the pair permanently silent. It presented as a
		 * flaky test: a race between presence syncing and the plan running, won
		 * about half the time. `addPeer` is idempotent per endpoint, so repeating
		 * it costs a map lookup and closes the race by construction.
		 */
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, not state
		const wantedPeers = new Set(plan.peers);
		for (const peer of wantedPeers) {
			await this.transport.addPeer(peer);
		}
		for (const peer of previous?.peers ?? []) {
			if (wantedPeers.has(peer)) continue;
			await this.transport.removePeer(peer);
		}

		if (plan.capture.video || plan.capture.audio || plan.capture.screen) {
			if (!this.grantIsFresh) await this.refreshGrant();
			// A publisher with no grant does not capture: prompting for a camera we
			// are not allowed to send would be the worst of both.
			if (this.grant === null) {
				await this.capture.reconcile({ video: false, audio: false });
				this.scheduleGrantRetry(tiles, screenTiles);
				return;
			}
			this.clearGrantRetry();
			this.options.onGrant?.(this.grant);
		}

		const changed = await this.capture.reconcile(plan.capture);
		this.cameraDenied = plan.capture.video && this.capture.denied;
		const own = this.capture.get('video');
		// A NEW MediaStream per track change rather than a mutated one: an element
		// re-reads `srcObject` on identity, not on content.
		this.localVideo = own === null ? null : new MediaStream([own]);
		/*
		 * Our own microphone track, exposed so the wiring site can measure its
		 * loudness (AR-MEDIA-6). A TRACK rather than a stream: the analyser wants
		 * one source, and wrapping it in a stream here would mint a new object
		 * every pass and restart the meter continuously.
		 */
		this.localAudio = this.capture.get('audio');
		for (const kind of changed) {
			const track = this.capture.get(kind);
			if (track === null) {
				await this.transport.unpublish(kind);
			} else {
				await this.transport.publish(kind, track);
			}
		}

		/*
		 * The active-speaker cap (AR-MEDIA-6, UX-STAGE-5).
		 *
		 * Applied AFTER the capture loop and separately from it, because the
		 * microphone stays open while gated — the publisher has to keep measuring
		 * its own loudness or it can never signal that it has started speaking
		 * again (see `plan.ts` for the latch this avoids).
		 *
		 * Acted on only when the gate CHANGES. Reconcile runs on every stage and
		 * tile change, and re-publishing an unchanged track each pass would
		 * renegotiate a connection several times a minute for no reason.
		 */
		if (plan.gateAudio !== this.audioGated) {
			this.audioGated = plan.gateAudio;
			const audioTrack = this.capture.get('audio');
			if (plan.gateAudio) {
				await this.transport.unpublish('audio');
			} else if (audioTrack !== null) {
				await this.transport.publish('audio', audioTrack);
			}
		}

		/*
		 * The screen arm. Note what it does NOT do: it never calls
		 * `screenCapture.start()`.
		 *
		 * `plan.capture.screen` is permission to publish, not an instruction to
		 * acquire — `getDisplayMedia` needs a user gesture, and by the time this
		 * runs (an effect, an addPeer loop, possibly a grant fetch) activation is
		 * long gone. Acquisition is imperative, from the click handler, via
		 * `startScreenShare`. If you are here to "fix" the asymmetry by moving the
		 * picker into this loop, it will throw for every user.
		 *
		 * What this DOES own is the stopping. A revoked slot, a lowered capacity,
		 * or a host ending your share all arrive as `capture.screen` going false,
		 * and this is what makes the track actually stop rather than merely
		 * becoming unauthorized.
		 */
		const screenTrack = this.screenCapture.current;
		const wantScreen = plan.capture.screen && screenTrack !== null;
		if (wantScreen && !this.publishedScreen) {
			await this.transport.publish('screen', screenTrack);
			this.publishedScreen = true;
			/*
			 * The self-view is the PICTURE only, never the sound (UX-OBJ-16).
			 *
			 * You already hear the tab you are sharing, from the tab itself. Putting
			 * the captured audio on your own element would play it a second time,
			 * slightly behind — and `muted={isSelf}` would have to be right forever
			 * for that never to happen. Leaving the track out makes it structural.
			 */
			this.localScreen = new MediaStream([screenTrack]);
		} else if (!wantScreen && this.publishedScreen) {
			await this.transport.unpublish('screen');
			this.publishedScreen = false;
			this.screenCapture.stop();
			this.localScreen = null;
		}

		// The sound follows the picture's authorization, and its own availability.
		const screenAudioTrack = this.screenCapture.currentAudio;
		const wantScreenAudio = wantScreen && screenAudioTrack !== null;
		if (wantScreenAudio && !this.publishedScreenAudio) {
			await this.transport.publish('screenaudio', screenAudioTrack);
			this.publishedScreenAudio = true;
		} else if (!wantScreenAudio && this.publishedScreenAudio) {
			await this.transport.unpublish('screenaudio');
			this.publishedScreenAudio = false;
		}

		// Subscriptions: whatever the plan asks for, at the rung it asks for.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, not state
		const wanted = new Map<string, { peer: PeerId; kind: MediaKind }>();
		for (const subscription of plan.subscriptions) {
			wanted.set(`${subscription.peer}:${subscription.kind}`, subscription);
			await this.transport.subscribe(subscription.peer, subscription.kind, subscription.layer);
		}
		for (const subscription of previous?.subscriptions ?? []) {
			if (wanted.has(`${subscription.peer}:${subscription.kind}`)) continue;
			await this.transport.unsubscribe(subscription.peer, subscription.kind);
		}

		await this.countConnections();
	}

	/**
	 * Open the screen picker (UX-OBJ-6).
	 *
	 * MUST be called directly from a click handler, awaiting nothing first, or
	 * the browser refuses for want of user activation. Returns null when the
	 * person cancelled, which is an ordinary answer.
	 *
	 * Deliberately does NOT take the slot: the caller commits
	 * `start_screenshare` once it has a track, so a cancelled picker cannot
	 * strand capacity. Ordering matters and is spelled out at the call site.
	 */
	async startScreenShare(): Promise<MediaStreamTrack | null> {
		return this.screenCapture.start();
	}

	/** Give up the track. The slot and the object are the caller's business. */
	stopScreenShare(): void {
		this.screenCapture.stop();
		this.localScreen = null;
		// Each flag checked separately. An early return on the picture's flag
		// would strand the SOUND on the wire whenever the two were out of step —
		// which they are, briefly, every time tab audio ends on its own.
		if (this.publishedScreenAudio) {
			this.publishedScreenAudio = false;
			void this.transport.unpublish('screenaudio');
		}
		if (this.publishedScreen) {
			this.publishedScreen = false;
			void this.transport.unpublish('screen');
		}
	}

	private pushStage(): void {
		const state = this.options.store.state;
		this.options.onStage?.({
			video: [...state.video_holders],
			audio: [...state.audio_holders],
			screen: [...state.screen_holders]
		});
	}



	dispose(): void {
		this.disposed = true;
		this.localVideo = null;
		this.localAudio = null;
		this.localScreen = null;
		this.clearGrantRetry();
		this.capture.dispose();
		this.screenCapture.dispose();
		this.transport.dispose();
	}
}
