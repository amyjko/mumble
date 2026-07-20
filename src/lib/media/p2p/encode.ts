import { AUDIO, LAYERS, scaleDownFor, type Layer } from '$lib/media/ladder';
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
