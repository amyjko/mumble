import type { StageState } from '$lib/model/stage';
import { audioPublishers, canPublishAudio, canPublishVideo } from '$lib/model/stage';
import { layerForWidth, type Layer } from './ladder';
import type { MediaKind, PeerId } from './transport';

/**
 * What this client should be sending and receiving, right now (AR-CTRL-3,
 * AR-MEDIA-5, UX-STAGE-3, UX-STAGE-10, UX-ROOM-1). Pure and node-tested.
 *
 * A desired state, not a set of commands. The session compares this to what the
 * transport is actually doing and converges — which means the hard part (what
 * SHOULD be true) is decided here, in a function that needs no browser, no
 * camera and no peer connection, and the imperative part is a diff.
 *
 * Authorization is NOT re-decided here. `stage.ts` already owns it, and this
 * calls the same predicates the server uses; a second copy of "who may publish"
 * is precisely how a client and a server come to disagree. What this adds is
 * everything authorization does not answer: whether there is anyone to talk to,
 * who to connect to, and at which rung.
 */

export interface TileSize {
	/** Rendered width in DEVICE pixels (CSS px × DPR) — what is actually painted. */
	readonly deviceWidth: number;
}

export interface PlanInput {
	readonly self: PeerId;
	/** The authoritative stage slice: capacity, holder lists, queue. */
	readonly stage: StageState;
	/** Everyone admitted AND present. Not members — see the note on AR-CTRL-3. */
	readonly present: readonly PeerId[];
	/** This client's own mute state (UX-STAGE-10). */
	readonly muted: boolean;
	/** How big each peer's tile is being drawn, for AR-MEDIA-5. */
	readonly tiles: ReadonlyMap<PeerId, TileSize>;
}

export interface Subscription {
	readonly peer: PeerId;
	readonly kind: MediaKind;
	readonly layer: Layer;
}

export interface MediaPlan {
	/** Whether to ask for a camera and a microphone AT ALL. */
	readonly capture: { readonly video: boolean; readonly audio: boolean };
	/** Peers to hold a connection to, whether or not anything flows yet. */
	readonly peers: readonly PeerId[];
	readonly subscriptions: readonly Subscription[];
}

/** Nothing to do: no capture, no connections, no subscriptions. */
const IDLE: MediaPlan = { capture: { video: false, audio: false }, peers: [], subscriptions: [] };

/**
 * Audio has no tile, so it has no size to choose a rung from. It takes the
 * bottom rung as a placeholder — `AUDIO` in the ladder is what actually bounds
 * voice, and no transport consults this value for an audio track.
 */
const AUDIO_LAYER: Layer = 'low';

export function planMedia(input: PlanInput): MediaPlan {
	/*
	 * The >=2-present rule (AR-CTRL-3, UX-ROOM-1): "no media session is
	 * established for a lone occupant".
	 *
	 * Returning early matters for a reason beyond cost. `capture` false means
	 * `getUserMedia` is never called, so someone sitting alone in a room — the
	 * most common state there is, since somebody always arrives first — is never
	 * shown a camera permission prompt for a call that is not happening.
	 *
	 * "Present" is deliberately not "member": a room with fifty members and one
	 * person in it is a lone occupant.
	 */
	const others = input.present.filter((peer) => peer !== input.self);
	if (others.length === 0) return IDLE;

	/*
	 * What to send. Both answers come from `stage.ts` unchanged, so the
	 * video-implies-audio rule (UX-STAGE-3 — a video holder publishes audio
	 * without consuming an audio slot) and mute (UX-STAGE-10) are honoured here
	 * by construction rather than by a second implementation of them.
	 */
	const capture = {
		video: canPublishVideo(input.stage, input.self),
		audio: canPublishAudio(input.stage, input.self, input.muted)
	};

	/*
	 * Connect to everyone present, including peers publishing nothing.
	 *
	 * AR-TRANSPORT-9 wants a slot handoff pre-warmed "a beat before the visible
	 * grant", and a connection that only appears when someone starts publishing
	 * cannot be warm — the negotiation would begin at exactly the moment the
	 * media is wanted. This is why `addPeer` is separate from `publish` on the
	 * transport interface.
	 */
	const peers = others;

	/*
	 * What to receive. A peer is subscribed to only if the STAGE authorizes them
	 * to publish it — the same holder lists the server enforces, so a client
	 * never asks for a track the sender is not allowed to send.
	 *
	 * Their mute state is deliberately not consulted: muting is UX-STAGE-10's
	 * "silences you without necessarily giving up a slot", so a muted holder is
	 * still authorized and simply sends nothing. Dropping the subscription would
	 * mean renegotiating every time somebody toggled their microphone.
	 */
	const speakers = new Set(audioPublishers(input.stage));
	const subscriptions: Subscription[] = [];

	for (const peer of others) {
		if (canPublishVideo(input.stage, peer)) {
			// AR-MEDIA-5: the rung follows the tile actually being drawn. An
			// unknown tile has not been measured yet, and `layerForWidth` treats
			// that as the cheapest rung rather than the most expensive.
			const tile = input.tiles.get(peer);
			subscriptions.push({
				peer,
				kind: 'video',
				layer: layerForWidth(tile?.deviceWidth ?? 0)
			});
		}
		if (speakers.has(peer)) {
			subscriptions.push({ peer, kind: 'audio', layer: AUDIO_LAYER });
		}
	}

	return { capture, peers, subscriptions };
}
