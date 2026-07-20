import { z } from 'zod';
import type { RoomStore } from '$lib/store/room-store';
import { stage } from '$lib/model/rules';
import { grantSchema, type Grant } from './grant';
import { planMedia, type MediaPlan, type TileSize } from './plan';
import { Capture } from './capture';
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
	readonly onStage?: (holders: { video: string[]; audio: string[] }) => void;
}

export class MediaSession {
	private readonly options: SessionOptions;
	private readonly transport: MediaTransport;
	private readonly capture = new Capture();

	private applied: MediaPlan | null = null;
	private grant: Grant | null = null;
	private grantExpiresAtMs = 0;
	private disposed = false;
	/** Set while a reconcile is in flight, so plans queue instead of racing. */
	private busy = false;
	private again = false;

	/** Live connection count, for the document attribute tests read. */
	connected = $state(0);

	constructor(options: SessionOptions) {
		this.options = options;
		this.transport = options.transport ?? new NullTransport();

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

	private get grantIsFresh(): boolean {
		return this.grant !== null && Date.now() < this.grantExpiresAtMs;
	}

	/**
	 * Bring the live session in line with what the plan wants.
	 *
	 * Serialized rather than concurrent: two reconciles interleaving would
	 * publish and unpublish the same track, and the second would win by accident.
	 */
	async reconcile(tiles: ReadonlyMap<PeerId, TileSize>): Promise<void> {
		if (this.disposed) return;
		if (this.busy) {
			this.again = true;
			return;
		}
		this.busy = true;
		try {
			await this.apply(tiles);
		} finally {
			this.busy = false;
			if (this.again) {
				this.again = false;
				void this.reconcile(tiles);
			}
		}
	}

	private async apply(tiles: ReadonlyMap<PeerId, TileSize>): Promise<void> {
		const state = this.options.store.state;
		const plan = planMedia({
			self: this.options.self,
			stage: stage(state),
			present: this.options.store.present,
			muted: state.participants[this.options.self]?.muted ?? false,
			tiles
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

		if (plan.capture.video || plan.capture.audio) {
			if (!this.grantIsFresh) await this.refreshGrant();
			// A publisher with no grant does not capture: prompting for a camera we
			// are not allowed to send would be the worst of both.
			if (this.grant === null) {
				await this.capture.reconcile({ video: false, audio: false });
				return;
			}
			this.options.onGrant?.(this.grant);
		}

		const changed = await this.capture.reconcile(plan.capture);
		for (const kind of changed) {
			const track = this.capture.get(kind);
			if (track === null) {
				await this.transport.unpublish(kind);
			} else {
				await this.transport.publish(kind, track);
			}
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

	private pushStage(): void {
		const state = this.options.store.state;
		this.options.onStage?.({
			video: [...state.video_holders],
			audio: [...state.audio_holders]
		});
	}



	dispose(): void {
		this.disposed = true;
		this.capture.dispose();
		this.transport.dispose();
	}
}
