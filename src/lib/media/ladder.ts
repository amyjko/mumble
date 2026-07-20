/**
 * The layer ladder (AR-MEDIA-3, AR-MEDIA-5). Pure and node-tested.
 *
 * One transport-agnostic vocabulary for "how much video". The ladder is the
 * SHARED language; each transport expresses it differently, and AR-MEDIA-3 says
 * plainly that conflating the two is a real cost bug:
 *
 *   - SFU (V2): the publisher uploads every layer once and the forwarder picks
 *     per subscriber — simulcast.
 *   - P2P (MVP): the publisher encodes each peer only the one layer that peer
 *     asked for. Sending a full ladder over P2P would multiply the binding
 *     constraint (per-publisher uplink) by the number of layers for no benefit,
 *     because there is no forwarder to choose between them.
 *
 * So this module names the rungs and nothing else. HOW a rung is delivered is a
 * transport's business and lives behind `MediaTransport` — which is also why
 * `publish()` takes no layer and `subscribe()` does.
 *
 * Nothing here touches WebRTC, and nothing here is reactive: it is arithmetic
 * over numbers a caller already has, which is what AR-TEST-4 asks of exactly
 * this kind of rule.
 */

/** The rungs. Audio is not one of them — see `AUDIO`. */
export type Layer = 'high' | 'med' | 'low';

export interface LayerSpec {
	/** Ceiling handed to the encoder, in bits per second. */
	readonly maxBitrateBps: number;
	readonly maxFramerate: number;
	/**
	 * The width this rung is FOR, in device pixels. Used to choose a rung for a
	 * tile, and to derive the encoder's downscale factor from a capture.
	 */
	readonly nominalWidth: number;
}

/**
 * AR-MEDIA-3's recommended defaults, as written ("tune per product"):
 *
 *     HIGH  ~0.6  Mbps   active speaker / large tile (~480–540p)
 *     MED   ~0.25 Mbps   medium visible tile
 *     LOW   ~0.10 Mbps   thumbnail
 *
 * Widths are read off those descriptions: 540p is the high rung's own stated
 * target, and the two below it step down by roughly a third each time, which is
 * where the bitrates already sit relative to one another.
 */
export const LAYERS: Readonly<Record<Layer, LayerSpec>> = {
	high: { maxBitrateBps: 600_000, maxFramerate: 30, nominalWidth: 540 },
	med: { maxBitrateBps: 250_000, maxFramerate: 24, nominalWidth: 360 },
	low: { maxBitrateBps: 100_000, maxFramerate: 15, nominalWidth: 180 }
};

/**
 * Opus voice (AR-MEDIA-3). Not a `Layer`: audio has one rung, it is never
 * chosen by tile size, and giving it a place in the same union would invite
 * code that asks a tile how loud it should be.
 */
export const AUDIO = { maxBitrateBps: 32_000 } as const;

/** Largest rung first, so the search below can stop at the first that fits. */
const DESCENDING: readonly Layer[] = ['high', 'med', 'low'];

/**
 * The rung for a tile rendered this wide, in DEVICE pixels (CSS pixels × DPR),
 * because that is the resolution actually painted.
 *
 * Rounds DOWN, never up, which is AR-MEDIA-5 in one line: "a subscriber never
 * receives more than their layout shows, at no higher quality than tiles
 * render; scale-to-fill requests no higher layer." A tile 500px wide gets `med`
 * — sending it 540p would be paying for pixels that are thrown away, and
 * scale-to-fill is exactly the case where a naive implementation rounds up.
 *
 * Floors at `low` rather than returning null: a tile too small for the bottom
 * rung still has to show something. Deciding NOT to subscribe at all is a
 * different question, and it belongs to the plan (AR-MEDIA-4 pauses off-screen
 * tiles), not here.
 */
export function layerForWidth(deviceWidth: number): Layer {
	// A degenerate or not-yet-measured tile takes the cheapest rung. Returning
	// `high` for width 0 — which a naive descending scan does if the guard is
	// forgotten — would make an unmeasured tile the most expensive one.
	if (!Number.isFinite(deviceWidth) || deviceWidth <= 0) return 'low';

	for (const layer of DESCENDING) {
		if (deviceWidth >= LAYERS[layer].nominalWidth) return layer;
	}
	return 'low';
}

/**
 * How far the encoder must downscale a capture to serve `layer`.
 *
 * WebRTC expresses this as `scaleResolutionDownBy` — a DIVISOR, so 2 means half
 * width. Never below 1: upscaling a small capture to fill a big tile spends
 * bitrate inventing detail that was never captured.
 */
export function scaleDownFor(captureWidth: number, layer: Layer): number {
	const target = LAYERS[layer].nominalWidth;
	if (!Number.isFinite(captureWidth) || captureWidth <= target) return 1;
	return captureWidth / target;
}
