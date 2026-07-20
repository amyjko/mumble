import {
	AUDIO,
	LAYERS,
	SCREEN_AUDIO,
	SCREEN_LAYERS,
	scaleDownFor,
	type Layer
} from '$lib/media/ladder';
import type { MediaKind } from '$lib/media/transport';

/**
 * A rung on the ladder, expressed as sender parameters (AR-MEDIA-3).
 *
 * On P2P the publisher encodes PER PEER: each subscriber has its own connection
 * and therefore its own sender, so two subscribers wanting different rungs get
 * two encodes and neither pays for the other's. That is the answer to the open
 * question DESIGN.md raises about "one encode per distinct layer, not per peer"
 * — with one connection per peer, per-connection IS per-distinct-layer, because
 * browsers do not share encoders across connections anyway.
 *
 * Sending a full simulcast ladder here would multiply the binding constraint
 * (per-publisher uplink) by the number of rungs for no benefit: there is no
 * forwarder in the middle to choose between them.
 *
 * Kept separate from the code that applies it so the arithmetic is testable in
 * node — applying involves a sender, and choosing does not.
 */

/**
 * What a subscriber's requested rung means for the encoder.
 *
 * `null` means stop sending, which is how unsubscribe and pause reach the
 * publisher as one message and one action. `active: false` genuinely stops
 * packets, so AR-MEDIA-4's "a paused subscription costs nothing" is a fact
 * rather than a UI convention — disabling the track at the RECEIVER would leave
 * the publisher paying full egress to send frames nobody decodes.
 */
export interface Encoding {
	active: boolean;
	maxBitrate?: number;
	maxFramerate?: number;
	scaleResolutionDownBy?: number;
	/**
	 * What to sacrifice when the encoder cannot keep up.
	 *
	 * A per-SENDER parameter rather than a per-encoding one, so the caller writes
	 * it onto `parameters` rather than into an encoding — but the CHOICE belongs
	 * here, where it is arithmetic over a kind and can be tested in node.
	 *
	 * Absent means "leave the browser's default alone", which is right for a
	 * camera: dropping resolution to hold a smooth face is the correct trade.
	 * It is the wrong trade for a screen, where a smooth blur is worthless and a
	 * sharp still is exactly what someone is trying to read.
	 */
	degradation?: 'maintain-resolution' | 'balanced';
}

export function encodingFor(
	kind: MediaKind,
	layer: Layer | null,
	captureWidth: number
): Encoding {
	if (layer === null) return { active: false };

	if (kind === 'audio') {
		// Audio has one rung. A ladder for speech would trade intelligibility for
		// a saving that is noise next to video, and UX-AUDIO-1 puts audio first.
		return { active: true, maxBitrate: AUDIO.maxBitrateBps };
	}

	if (kind === 'screenaudio') {
		/*
		 * A share's own sound (UX-OBJ-16). Bitrate and NOTHING else.
		 *
		 * No framerate, no downscale, no degradation preference — `applyWanted`
		 * spreads whatever is present onto `parameters.encodings`, and a video
		 * field on an audio sender makes `setParameters` reject the whole call.
		 * Silently, because the call is `void`ed: the rung would simply never be
		 * applied and nothing would say so.
		 */
		return { active: true, maxBitrate: SCREEN_AUDIO.maxBitrateBps };
	}

	if (kind === 'screen') {
		// Detail over motion (UX-OBJ-6). The nominal widths are far larger than
		// the camera ladder's, so `scaleDownFor` returns 1 for most real captures
		// — a downscaled screen is illegible in a way a downscaled face is not,
		// and refusing to shrink it is the whole point of the separate ladder.
		const screen = SCREEN_LAYERS[layer];
		return {
			active: true,
			maxBitrate: screen.maxBitrateBps,
			maxFramerate: screen.maxFramerate,
			scaleResolutionDownBy: scaleDownFor(captureWidth, layer, true),
			degradation: 'maintain-resolution'
		};
	}

	const spec = LAYERS[layer];
	return {
		active: true,
		maxBitrate: spec.maxBitrateBps,
		maxFramerate: spec.maxFramerate,
		// Never below 1: asking the encoder to scale UP would cost bandwidth to
		// invent detail the capture never had.
		scaleResolutionDownBy: scaleDownFor(captureWidth, layer)
	};
}
