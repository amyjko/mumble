import { describe, expect, it } from 'vitest';
import { AUDIO, LAYERS, layerForWidth, scaleDownFor, type Layer } from './ladder';

/**
 * The layer ladder (AR-MEDIA-3, AR-MEDIA-5).
 *
 * Node-only: it is arithmetic, and AR-TEST-4 wants exactly this kind of rule
 * testable without a browser or a peer connection.
 */

describe('the ladder itself', () => {
	it('descends in both bitrate and size', () => {
		// The rungs have to be ORDERED to mean anything — a ladder whose middle
		// rung costs more than its top is not a ladder, and every consumer here
		// assumes the ordering without checking it.
		expect(LAYERS.high.maxBitrateBps).toBeGreaterThan(LAYERS.med.maxBitrateBps);
		expect(LAYERS.med.maxBitrateBps).toBeGreaterThan(LAYERS.low.maxBitrateBps);
		expect(LAYERS.high.nominalWidth).toBeGreaterThan(LAYERS.med.nominalWidth);
		expect(LAYERS.med.nominalWidth).toBeGreaterThan(LAYERS.low.nominalWidth);
	});

	it('matches the figures the requirement states', () => {
		// AR-MEDIA-3 names ~0.6 / ~0.25 / ~0.10 Mbps and ~0.02-0.035 for voice.
		// Pinned so a future tuning pass is a deliberate edit to a requirement
		// rather than a silent drift away from one.
		expect(LAYERS.high.maxBitrateBps).toBe(600_000);
		expect(LAYERS.med.maxBitrateBps).toBe(250_000);
		expect(LAYERS.low.maxBitrateBps).toBe(100_000);
		expect(AUDIO.maxBitrateBps).toBeGreaterThanOrEqual(20_000);
		expect(AUDIO.maxBitrateBps).toBeLessThanOrEqual(35_000);
	});
});

describe('layerForWidth', () => {
	it('gives a big tile the top rung and a thumbnail the bottom', () => {
		expect(layerForWidth(1920)).toBe('high');
		expect(layerForWidth(540)).toBe('high');
		expect(layerForWidth(360)).toBe('med');
		expect(layerForWidth(96)).toBe('low');
	});

	it('rounds DOWN, so scale-to-fill never asks for more than it shows', () => {
		// THE AR-MEDIA-5 assertion. A 500px tile is nearly a `high` tile, and
		// rounding to the nearest rung would hand it 540p — paying for pixels
		// that get thrown away. "Scale-to-fill requests no higher layer" is
		// precisely the case a naive implementation gets wrong.
		expect(layerForWidth(539)).toBe('med');
		expect(layerForWidth(359)).toBe('low');
	});

	it('treats an unmeasured tile as the CHEAPEST, not the most expensive', () => {
		// A descending scan without a guard returns the first rung for width 0,
		// which is `high` — so a tile that has not been measured yet would become
		// the most expensive subscription in the room.
		expect(layerForWidth(0)).toBe('low');
		expect(layerForWidth(-1)).toBe('low');
		expect(layerForWidth(Number.NaN)).toBe('low');
	});

	it('never returns a rung whose nominal width exceeds the tile', () => {
		// The property behind the examples, over the whole plausible range.
		for (let width = 1; width <= 2000; width += 7) {
			const layer: Layer = layerForWidth(width);
			if (layer !== 'low') expect(LAYERS[layer].nominalWidth).toBeLessThanOrEqual(width);
		}
	});
});

describe('scaleDownFor', () => {
	it('downscales a large capture to the rung', () => {
		expect(scaleDownFor(1080, 'high')).toBeCloseTo(2);
		expect(scaleDownFor(1080, 'low')).toBeCloseTo(6);
	});

	it('never UPscales', () => {
		// `scaleResolutionDownBy` below 1 would upscale, spending bitrate
		// inventing detail the camera never captured.
		expect(scaleDownFor(320, 'high')).toBe(1);
		expect(scaleDownFor(540, 'high')).toBe(1);
		expect(scaleDownFor(Number.NaN, 'high')).toBe(1);
	});
});
