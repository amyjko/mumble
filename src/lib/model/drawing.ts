import type { Point } from './types';

/**
 * Pure helpers for freehand drawings (UX-OBJ-11). A stroke is captured in world
 * coordinates, then its bounding box becomes the object's transform and the
 * points are normalized to 0–100 within that box — so the drawing scales with
 * the object (SVG viewBox 0 0 100 100, preserveAspectRatio none). Node-tested.
 */

export interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Bounding box of a world-space stroke, padded so thin/flat strokes have area. */
export function strokeBounds(points: readonly Point[], pad = 8): Bounds {
	const first = points[0];
	if (first === undefined) return { x: 0, y: 0, width: pad * 2, height: pad * 2 };
	let minX = first.x;
	let minY = first.y;
	let maxX = first.x;
	let maxY = first.y;
	for (const p of points) {
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
		maxX = Math.max(maxX, p.x);
		maxY = Math.max(maxY, p.y);
	}
	return {
		x: minX - pad,
		y: minY - pad,
		width: Math.max(1, maxX - minX) + pad * 2,
		height: Math.max(1, maxY - minY) + pad * 2
	};
}

/** World points → 0–100 within the given box. */
export function normalizePoints(points: readonly Point[], box: Bounds): Point[] {
	return points.map((p) => ({
		x: ((p.x - box.x) / box.width) * 100,
		y: ((p.y - box.y) / box.height) * 100
	}));
}

/** Normalized points → an SVG path string (smooth-ish via line segments). */
export function pointsToPath(points: readonly Point[]): string {
	if (points.length === 0) return '';
	const [head, ...rest] = points;
	if (head === undefined) return '';
	const round = (n: number): string => (Math.round(n * 100) / 100).toString();
	let d = `M ${round(head.x)} ${round(head.y)}`;
	for (const p of rest) d += ` L ${round(p.x)} ${round(p.y)}`;
	return d;
}

/** Drop points closer than `min` (in world units) to thin dense captures. */
export function simplify(points: readonly Point[], min = 2): Point[] {
	const out: Point[] = [];
	for (const p of points) {
		const last = out[out.length - 1];
		if (last === undefined || Math.hypot(p.x - last.x, p.y - last.y) >= min) out.push(p);
	}
	return out;
}
