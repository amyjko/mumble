import type { Clip } from './types';

/** Named shapes the shape-cycle steps through (UX-OBJ-7). */
export const CLIP_CYCLE: Clip[] = [
	{ shape: 'rect' },
	// 24, not 8: at 8 the rounded step was visually identical to `rect`, so the
	// cycle appeared to contain two rectangles and users toggled twice to get
	// anywhere. A shape step that cannot be seen is a step that is not there.
	{ shape: 'rounded', radius: 24 },
	{ shape: 'circle' },
	{ shape: 'ellipse' },
	{ shape: 'polygon', points: hexagon() }
];

export function nextClip(current: Clip): Clip {
	const i = CLIP_CYCLE.findIndex((c) => c.shape === current.shape);
	return CLIP_CYCLE[(i + 1) % CLIP_CYCLE.length] ?? { shape: 'rect' };
}

export function clipLabel(clip: Clip): string {
	return clip.shape;
}

/** A flat-top hexagon in the 0–100 box. */
export function hexagon(): { x: number; y: number }[] {
	return [
		{ x: 25, y: 0 },
		{ x: 75, y: 0 },
		{ x: 100, y: 50 },
		{ x: 75, y: 100 },
		{ x: 25, y: 100 },
		{ x: 0, y: 50 }
	];
}

/**
 * The CSS clip-path for a shape, or null when the shape is expressed via
 * border-radius instead (rect/rounded/circle). Percentage-based so it scales
 * with the object.
 */
export function clipPathCss(clip: Clip): string | null {
	switch (clip.shape) {
		case 'ellipse':
			return 'ellipse(50% 50% at 50% 50%)';
		case 'polygon':
			return `polygon(${clip.points.map((p) => `${String(p.x)}% ${String(p.y)}%`).join(', ')})`;
		default:
			return null;
	}
}

/**
 * The shape's outline as an SVG element description, in a 0–100 box.
 *
 * Exists because a DASHED outline cannot be drawn with `clip-path`: clipping a
 * bordered box removes the border rather than bending it, which is the same
 * failure the sticker border had (UX-OBJ-8) — and there the fix was a second
 * clipped layer forming a ring, which cannot be dashed. Stroking a real path
 * is the only way to get a dashed edge that follows an ellipse or a hexagon.
 *
 * Coordinates are percentages so the caller can render at any size with
 * `viewBox="0 0 100 100"` and `preserveAspectRatio="none"`; pair that with
 * `vector-effect="non-scaling-stroke"` or a non-square box will stretch the
 * dashes.
 */
export type Outline =
	| { kind: 'rect'; rx: number; ry: number }
	| { kind: 'ellipse' }
	| { kind: 'polygon'; points: { x: number; y: number }[] };

export function outlineFor(clip: Clip, width: number, height: number): Outline {
	switch (clip.shape) {
		case 'rect':
			return { kind: 'rect', rx: 0, ry: 0 };
		case 'rounded':
			// Radius is in pixels but the box is 0–100, and x and y scale
			// independently — so the corner is elliptical, matching what
			// border-radius actually paints on a non-square box. Using one axis
			// for both would visibly disagree with the object it describes.
			return {
				kind: 'rect',
				rx: (clip.radius / Math.max(width, 1)) * 100,
				ry: (clip.radius / Math.max(height, 1)) * 100
			};
		case 'circle':
		case 'ellipse':
			// `circle` is border-radius 50%, which on a non-square box paints an
			// ellipse — so both map to the same outline. Calling this an ellipse
			// is the honest description of what the user sees.
			return { kind: 'ellipse' };
		case 'polygon':
			return { kind: 'polygon', points: clip.points };
	}
}
