import { describe, expect, it } from 'vitest';
import { BASE_SPACING, MAX_SCREEN_SPACING, MIN_SCREEN_SPACING, gridFor } from './grid';

/** The zoom range the viewport actually permits, plus margin on both ends. */
const SCALES = Array.from({ length: 200 }, (_, i) => 0.05 * Math.pow(1.05, i));

describe('the dot grid stays legible at any zoom (UX-CANVAS-6)', () => {
	it('keeps on-screen spacing inside the legible range at EVERY scale', () => {
		// A property, not samples. The interesting failure is not "wrong at 3×"
		// but "wrong in a band nobody happened to try", which sampling misses.
		for (const scale of SCALES) {
			const { px } = gridFor({ x: 0, y: 0, scale });
			expect(px, `scale ${String(scale)}`).toBeGreaterThanOrEqual(MIN_SCREEN_SPACING);
			expect(px, `scale ${String(scale)}`).toBeLessThanOrEqual(MAX_SCREEN_SPACING);
		}
	});

	it('is a doubling/halving of the base spacing, never an arbitrary number', () => {
		// LOD must land on power-of-two multiples of the base, or the grid
		// visibly jumps to a new alignment instead of subdividing in place.
		for (const scale of SCALES) {
			const { px } = gridFor({ x: 0, y: 0, scale });
			const ratio = px / (BASE_SPACING * scale);
			const log2 = Math.log2(ratio);
			expect(Math.abs(log2 - Math.round(log2)), `scale ${String(scale)}`).toBeLessThan(1e-9);
		}
	});

	it('tracks the camera exactly, so dots stay glued to world coordinates', () => {
		const grid = gridFor({ x: -137.5, y: 42, scale: 1 });
		expect(grid.x).toBe(-137.5);
		expect(grid.y).toBe(42);
	});

	it('at scale 1 the base spacing is already legible and is left alone', () => {
		expect(gridFor({ x: 0, y: 0, scale: 1 }).px).toBe(BASE_SPACING);
	});

	it('stays finite at absurd scales the viewport cannot even reach', () => {
		// Extreme zoom is where a log2/pow formulation goes wrong (0, Infinity,
		// NaN) rather than merely inelegant, and the canvas has no way to
		// report a NaN background-size — the grid just silently vanishes.
		for (const scale of [1e-9, 1e-6, 1e6, 1e9]) {
			const { px } = gridFor({ x: 0, y: 0, scale });
			expect(Number.isFinite(px), `scale ${String(scale)}`).toBe(true);
			expect(px, `scale ${String(scale)}`).toBeGreaterThan(0);
		}
	});
});
