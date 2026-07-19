import type { Camera } from '$lib/model/types';

/** World-space spacing of the base grid, before level-of-detail doubling. */
export const BASE_SPACING = 24;
/** Legible range for on-screen dot spacing. Outside it the grid is noise or absent. */
export const MIN_SCREEN_SPACING = 14;
export const MAX_SCREEN_SPACING = 56;

export interface Grid {
	/** On-screen spacing in CSS pixels, always within the legible range. */
	px: number;
	x: number;
	y: number;
}

/**
 * The dot grid in world space (UX-CANVAS-6): position and scale track the
 * camera so dots stay glued to world coordinates, with level-of-detail
 * doubling/halving so effective spacing stays legible at any zoom.
 *
 * Extracted from WorldCanvas so the LOD invariant can be tested as a property
 * across the whole zoom range rather than eyeballed at a few zoom levels.
 *
 * Closed form rather than the doubling loop it replaces — same results, one
 * expression instead of two loops whose termination you have to reason about.
 * (I first wrote here that the loop version could spin forever if the legible
 * range were narrowed below 2×. That was wrong: the loops run in sequence, not
 * in a cycle, so each terminates regardless. Narrowing the range yields
 * out-of-range SPACING, which is what the property test below actually
 * catches. Recording the correction because the false version was more
 * interesting than the truth, which is how it got written down.)
 */
export function gridFor(camera: Camera): Grid {
	// Smallest doubling that reaches the legible floor. Halvings fall out of
	// the same expression as negative exponents.
	const steps = Math.ceil(Math.log2(MIN_SCREEN_SPACING / (BASE_SPACING * camera.scale)));
	const px = BASE_SPACING * camera.scale * Math.pow(2, steps);
	return { px, x: camera.x, y: camera.y };
}
