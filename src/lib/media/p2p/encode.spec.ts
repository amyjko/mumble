import { describe, expect, it } from 'vitest';
import { LAYERS, AUDIO } from '$lib/media/ladder';
import { encodingFor } from './encode';

/**
 * Turning a requested rung into sender parameters.
 *
 * Pure arithmetic, tested here rather than through a connection: applying these
 * needs a sender, choosing them does not, and the choosing is where a cost bug
 * would live.
 */

describe('video', () => {
	it('carries the ladder’s numbers rather than inventing its own', () => {
		// AR-MEDIA-3's rungs exist once. A second copy here would drift.
		const high = encodingFor('video', 'high', 1280);
		expect(high.maxBitrate).toBe(LAYERS.high.maxBitrateBps);
		expect(high.maxFramerate).toBe(LAYERS.high.maxFramerate);
	});

	it('scales down for a small tile, not up for a large one', () => {
		// Scaling up spends uplink inventing detail the capture never had.
		expect(encodingFor('video', 'low', 1280).scaleResolutionDownBy).toBeGreaterThan(1);
		expect(encodingFor('video', 'high', 320).scaleResolutionDownBy).toBe(1);
	});

	it('gives a bigger rung a bigger budget', () => {
		const low = encodingFor('video', 'low', 1280).maxBitrate ?? 0;
		const med = encodingFor('video', 'med', 1280).maxBitrate ?? 0;
		const high = encodingFor('video', 'high', 1280).maxBitrate ?? 0;
		expect(low).toBeLessThan(med);
		expect(med).toBeLessThan(high);
	});
});

describe('audio', () => {
	it('has one rung, whatever layer is asked for', () => {
		// A ladder for speech trades intelligibility for a saving that is noise
		// beside video, and UX-AUDIO-1 puts audio first.
		for (const layer of ['high', 'med', 'low'] as const) {
			const encoding = encodingFor('audio', layer, 1280);
			expect(encoding.maxBitrate).toBe(AUDIO.maxBitrateBps);
		}
	});

	it('never carries a resolution or framerate', () => {
		const encoding = encodingFor('audio', 'high', 1280);
		expect(encoding.scaleResolutionDownBy).toBeUndefined();
		expect(encoding.maxFramerate).toBeUndefined();
	});
});

describe('stopping', () => {
	it('deactivates rather than merely shrinking', () => {
		/*
		 * The cost property. `active: false` stops packets, so a paused
		 * subscription costs the publisher nothing (AR-MEDIA-4). The tempting
		 * alternative — disabling the track at the RECEIVER — leaves the
		 * publisher paying full egress to send frames nobody decodes.
		 */
		for (const kind of ['video', 'audio'] as const) {
			const stopped = encodingFor(kind, null, 1280);
			expect(stopped.active).toBe(false);
			expect(stopped.maxBitrate).toBeUndefined();
		}
	});
});
