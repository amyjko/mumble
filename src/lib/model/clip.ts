import type { Clip } from './types';

/** Named shapes the shape-cycle steps through (UX-OBJ-7). */
export const CLIP_CYCLE: Clip[] = [
	{ shape: 'rect' },
	{ shape: 'rounded', radius: 8 },
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
