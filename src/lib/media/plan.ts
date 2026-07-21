import type { StageState } from '$lib/model/stage';
import {
	audioPublishers,
	canPublishAudio,
	canPublishScreen,
	canPublishVideo
} from '$lib/model/stage';
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
	/**
	 * How big each peer's SCREEN SHARE object is being drawn (UX-OBJ-6).
	 *
	 * A second map keyed by the sharing peer rather than a wider key on `tiles`:
	 * one share per person makes the key unambiguous, and every existing caller
	 * and test keeps working. A share and its owner's avatar are different sizes
	 * on the canvas and must choose rungs independently.
	 */
	readonly screenTiles?: ReadonlyMap<PeerId, TileSize>;
	/**
	 * Who the active-speaker cap currently admits (AR-MEDIA-6, UX-STAGE-5).
	 *
	 * Computed by `selectActiveSpeakers` from the shared voice levels — passed IN
	 * rather than computed here so this function stays a pure function of its
	 * arguments with no clock, and so selection keeps its single home in
	 * `model/stage.ts`.
	 *
	 * `undefined` means "no selection has been computed", which applies no cap.
	 * That is the honest default for a planner that may run before the first
	 * level has arrived: the alternative — treating an empty selection as
	 * "nobody may speak" — would mute the room for the moment before anyone has
	 * measured anything, which is exactly when somebody is starting to talk.
	 */
	readonly activeSpeakers?: readonly PeerId[] | undefined;
}

export interface Subscription {
	readonly peer: PeerId;
	readonly kind: MediaKind;
	readonly layer: Layer;
}

export interface MediaPlan {
	/**
	 * Whether to ask for a camera and a microphone AT ALL — and whether a screen
	 * share MAY be published.
	 *
	 * `screen` reads differently from the other two, and the difference is
	 * load-bearing. `video` and `audio` are instructions: true means acquire.
	 * `screen` is an AUTHORIZATION: true means publish the track if one is held,
	 * false means stop. Nothing acts on it by opening a picker, because
	 * `getDisplayMedia` needs a user gesture that no reconcile loop has. See
	 * `ScreenCapture`.
	 */
	readonly capture: {
		readonly video: boolean;
		readonly audio: boolean;
		readonly screen: boolean;
	};
	/** Peers to hold a connection to, whether or not anything flows yet. */
	readonly peers: readonly PeerId[];
	readonly subscriptions: readonly Subscription[];
	/**
	 * Authorized to publish audio, but not currently among the active speakers
	 * (AR-MEDIA-6). The microphone stays open so loudness can still be measured;
	 * the track is simply not sent. See the note beside its computation.
	 */
	readonly gateAudio: boolean;
}

/** Nothing to do: no capture, no connections, no subscriptions. */
const IDLE: MediaPlan = {
	capture: { video: false, audio: false, screen: false },
	peers: [],
	subscriptions: [],
	gateAudio: false
};

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
	/*
	 * The active-speaker cap, enforced AT THE SOURCE (AR-MEDIA-6).
	 *
	 * "On P2P there is no forwarder, so unselected publishers gate their own
	 * track at the source" — and this is that gate, expressed as the capture
	 * plan rather than as a new mechanism. An unselected publisher stops
	 * capturing audio, so the track is not merely disabled at some receiver: it
	 * is not sent, and the encoder is not paying for it.
	 *
	 * Layered ON TOP of authorization, never instead of it. `canPublishAudio`
	 * still decides who MAY speak (slots, the union rule, mute); this only
	 * narrows that set further, and `selectActiveSpeakers` cannot widen it.
	 */
	const capture = {
		video: canPublishVideo(input.stage, input.self),
		audio: canPublishAudio(input.stage, input.self, input.muted),
		screen: canPublishScreen(input.stage, input.self)
	};

	/*
	 * The active-speaker cap gates the PUBLICATION, not the capture
	 * (AR-MEDIA-6).
	 *
	 * The obvious implementation — drop `capture.audio` for an unselected
	 * speaker — LATCHES, and the bug is worth keeping written down because it
	 * looks correct. Selection is driven by each publisher measuring their own
	 * microphone; stop capturing and the analyser has nothing to read, so a
	 * gated person reports silence forever and can never signal that they have
	 * started talking again. The same trap catches `track.enabled = false`, since
	 * a disabled track feeds silence to Web Audio too.
	 *
	 * So the microphone stays open and measured, and the TRACK IS NOT SENT.
	 * That is what "unselected publishers gate their own track at the source"
	 * buys on a mesh: no bytes leave, and the person can still be heard to start
	 * speaking by the only listener who matters for selection — themselves.
	 *
	 * Muting is unaffected and remains the way to actually close the microphone
	 * (UX-STAGE-10): being gated is the room's arithmetic, muting is your choice.
	 */
	const gateAudio =
		capture.audio &&
		input.activeSpeakers !== undefined &&
		!input.activeSpeakers.includes(input.self);

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
		if (canPublishScreen(input.stage, peer)) {
			/*
			 * The rung follows the SHARE's own size, not the sharer's avatar.
			 *
			 * They are different objects at different scales — someone's face may
			 * be a thumbnail while their screen fills half the canvas — and reading
			 * the avatar's width here would send a full-screen share at thumbnail
			 * quality. AR-MEDIA-5 still binds: no rung above what the layout shows.
			 */
			const tile = input.screenTiles?.get(peer);
			subscriptions.push({
				peer,
				kind: 'screen',
				layer: layerForWidth(tile?.deviceWidth ?? 0)
			});
			/*
			 * The share's own sound (UX-OBJ-16), under the SAME guard — holding a
			 * screen slot is what authorizes both halves.
			 *
			 * Subscribed unconditionally, because whether a share HAS sound is not
			 * knowable from the stage: it depends on a checkbox in the sharer's own
			 * picker. A subscription for a track nobody sends costs one message and
			 * delivers nothing, which is the right way round — the alternative is
			 * silence that only appears for some shares and nobody can explain.
			 */
			subscriptions.push({ peer, kind: 'screenaudio', layer: AUDIO_LAYER });
		}
		if (speakers.has(peer)) {
			subscriptions.push({ peer, kind: 'audio', layer: AUDIO_LAYER });
		}
	}

	return { capture, peers, subscriptions, gateAudio };
}
