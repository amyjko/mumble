import { describe, expect, it } from 'vitest';
import { LAYERS, AUDIO, SCREEN_AUDIO } from '$lib/media/ladder';
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

describe('screen (UX-OBJ-6)', () => {
	it('spends framerate to buy resolution', () => {
		// The trade that defines the screen ladder. A slide at 5fps is fine; a
		// slide too small to read is not a slide.
		const screen = encodingFor('screen', 'high', 1920);
		const camera = encodingFor('video', 'high', 1920);
		expect(screen.maxFramerate ?? 0).toBeLessThan(camera.maxFramerate ?? 0);
		expect(screen.maxBitrate ?? 0).toBeGreaterThan(camera.maxBitrate ?? 0);
	});

	it('gives its BOTTOM rung more than the camera ladder gives its top', () => {
		// The concrete failure this rules out: a share on a small tile rendered at
		// thumbnail quality, where text is present but unreadable.
		const screenLow = encodingFor('screen', 'low', 1920).maxBitrate ?? 0;
		const cameraHigh = encodingFor('video', 'high', 1920).maxBitrate ?? 0;
		expect(screenLow).toBeLessThan(cameraHigh);
		expect(screenLow).toBeGreaterThan(encodingFor('video', 'low', 1920).maxBitrate ?? 0);
	});

	it('refuses to downscale a capture the camera ladder would shrink', () => {
		// 1280 is above every camera nominal width and at the screen ladder's top
		// rung, so the same capture is shrunk for a face and left alone for text.
		expect(encodingFor('video', 'high', 1280).scaleResolutionDownBy).toBeGreaterThan(1);
		expect(encodingFor('screen', 'high', 1280).scaleResolutionDownBy).toBe(1);
	});

	it('holds resolution rather than smoothness when the encoder is squeezed', () => {
		expect(encodingFor('screen', 'med', 1280).degradation).toBe('maintain-resolution');
		// A camera keeps the browser's own preference, which is the right one.
		expect(encodingFor('video', 'med', 1280).degradation).toBeUndefined();
	});

	it('still steps monotonically across rungs', () => {
		const low = encodingFor('screen', 'low', 1920).maxBitrate ?? 0;
		const med = encodingFor('screen', 'med', 1920).maxBitrate ?? 0;
		const high = encodingFor('screen', 'high', 1920).maxBitrate ?? 0;
		expect(low).toBeLessThan(med);
		expect(med).toBeLessThan(high);
	});
});

describe('screen audio (UX-OBJ-16)', () => {
	it('is priced for music, not speech', () => {
		// The two constants must never be collapsed: 32 kbps is a SPEECH budget,
		// and Opus spends it on the frequencies a voice occupies. Asserted as an
		// inequality as well as a value, so a future "simplification" that reuses
		// AUDIO here fails rather than quietly degrading every share.
		const screen = encodingFor('screenaudio', 'high', 0);
		expect(screen.maxBitrate).toBe(SCREEN_AUDIO.maxBitrateBps);
		expect(screen.maxBitrate).not.toBe(AUDIO.maxBitrateBps);
		expect(screen.maxBitrate ?? 0).toBeGreaterThan(AUDIO.maxBitrateBps);
	});

	it('carries NO video fields, at any rung', () => {
		/*
		 * `applyWanted` spreads whatever is present onto `parameters.encodings`,
		 * and a video field on an audio sender makes `setParameters` reject the
		 * whole call — silently, because it is `void`ed. The rung would simply
		 * never apply and nothing would say so.
		 */
		for (const layer of ['high', 'med', 'low'] as const) {
			const encoding = encodingFor('screenaudio', layer, 1920);
			expect(encoding.maxFramerate).toBeUndefined();
			expect(encoding.scaleResolutionDownBy).toBeUndefined();
			expect(encoding.degradation).toBeUndefined();
		}
	});

	it('has one rung, like every other audio', () => {
		const high = encodingFor('screenaudio', 'high', 1920).maxBitrate;
		const low = encodingFor('screenaudio', 'low', 320).maxBitrate;
		expect(high).toBe(low);
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
		for (const kind of ['video', 'audio', 'screen', 'screenaudio'] as const) {
			const stopped = encodingFor(kind, null, 1280);
			expect(stopped.active).toBe(false);
			expect(stopped.maxBitrate).toBeUndefined();
		}
	});
});
