import type { Camera, Point, Size, SolverShape } from '$lib/model/types';

/**
 * Pure math, no runes, no DOM (AR-TEST-4): screen↔world conversion, fit-all,
 * and the contact-and-slide overlap solver (UX-OBJ-12, AR-CANVAS-5). The same
 * functions run during drag (client, every frame) and at commit (store-side
 * revalidation) — one rule, two enforcement points.
 */

/** World transform is translate(camera.x, camera.y) then scale(camera.scale). */
export function screenToWorld(p: Point, camera: Camera): Point {
	return { x: (p.x - camera.x) / camera.scale, y: (p.y - camera.y) / camera.scale };
}

export function worldToScreen(p: Point, camera: Camera): Point {
	return { x: p.x * camera.scale + camera.x, y: p.y * camera.scale + camera.y };
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;

/** Zoom about a screen point: the world point under the cursor stays put. */
export function zoomAt(camera: Camera, screenPoint: Point, factor: number): Camera {
	const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, camera.scale * factor));
	const world = screenToWorld(screenPoint, camera);
	return {
		scale,
		x: screenPoint.x - world.x * scale,
		y: screenPoint.y - world.y * scale
	};
}

export interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function unionBounds(all: readonly Bounds[]): Bounds | null {
	const first = all[0];
	if (first === undefined) return null;
	let minX = first.x;
	let minY = first.y;
	let maxX = first.x + first.width;
	let maxY = first.y + first.height;
	for (const b of all) {
		minX = Math.min(minX, b.x);
		minY = Math.min(minY, b.y);
		maxX = Math.max(maxX, b.x + b.width);
		maxY = Math.max(maxY, b.y + b.height);
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** UX-CANVAS-3 auto-zoom: camera that fits all content with padding. */
export function fitAll(content: Bounds, viewport: Size, padding = 48): Camera {
	const availW = Math.max(1, viewport.width - padding * 2);
	const availH = Math.max(1, viewport.height - padding * 2);
	const scale = Math.min(
		MAX_SCALE,
		Math.max(MIN_SCALE, Math.min(availW / Math.max(1, content.width), availH / Math.max(1, content.height), 1))
	);
	return {
		scale,
		x: (viewport.width - content.width * scale) / 2 - content.x * scale,
		y: (viewport.height - content.height * scale) / 2 - content.y * scale
	};
}

/**
 * The overlap rule (UX-OBJ-12): objects may overlap only by their sticker
 * borders. Equivalently, each shape's CONTENT — the shape inset by its own
 * border — may never intersect another's. Collision tests the clip geometry
 * (AR-CANVAS-5): a circle-clipped tile must not reserve its corners.
 */

interface ContentCircle {
	kind: 'circle';
	cx: number;
	cy: number;
	r: number;
}

interface ContentRect {
	kind: 'rect';
	x: number;
	y: number;
	w: number;
	h: number;
}

type Content = ContentCircle | ContentRect;

function contentOf(s: SolverShape, x: number, y: number): Content {
	if (s.circle) {
		const r = Math.max(0, Math.min(s.width, s.height) / 2 - s.border);
		return { kind: 'circle', cx: x + s.width / 2, cy: y + s.height / 2, r };
	}
	const inset = Math.min(s.border, s.width / 2, s.height / 2);
	return {
		kind: 'rect',
		x: x + inset,
		y: y + inset,
		w: s.width - inset * 2,
		h: s.height - inset * 2
	};
}

function intersects(a: Content, b: Content): boolean {
	if (a.kind === 'rect' && b.kind === 'rect') {
		return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
	}
	if (a.kind === 'circle' && b.kind === 'circle') {
		const dx = a.cx - b.cx;
		const dy = a.cy - b.cy;
		const rr = a.r + b.r;
		return dx * dx + dy * dy < rr * rr;
	}
	const circle = a.kind === 'circle' ? a : b;
	const rect = a.kind === 'rect' ? a : b;
	if (rect.kind !== 'rect' || circle.kind !== 'circle') return false;
	const nx = Math.max(rect.x, Math.min(circle.cx, rect.x + rect.w));
	const ny = Math.max(rect.y, Math.min(circle.cy, rect.y + rect.h));
	const dx = circle.cx - nx;
	const dy = circle.cy - ny;
	return dx * dx + dy * dy < circle.r * circle.r;
}

function collidesAt(moving: SolverShape, x: number, y: number, others: readonly SolverShape[]): boolean {
	const content = contentOf(moving, x, y);
	for (const other of others) {
		if (other.id === moving.id) continue;
		if (intersects(content, contentOf(other, other.x, other.y))) return true;
	}
	return false;
}

/**
 * Largest t in [0,1] along the segment with no content intersection. Swept,
 * not endpoint-only: a long move can pass clean THROUGH an obstacle and be
 * collision-free at both ends, so the path is sampled at ≤4px resolution to
 * find first contact, then binary-refined to sub-pixel. One code path for
 * every shape pair.
 */
function maxFreeT(
	moving: SolverShape,
	fromX: number,
	fromY: number,
	toX: number,
	toY: number,
	others: readonly SolverShape[]
): number {
	if (collidesAt(moving, fromX, fromY, others)) return 0;
	const distance = Math.hypot(toX - fromX, toY - fromY);
	if (distance === 0) return 1;
	const steps = Math.min(256, Math.max(8, Math.ceil(distance / 4)));
	let lastFree = 0;
	let firstHit = -1;
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		const x = fromX + (toX - fromX) * t;
		const y = fromY + (toY - fromY) * t;
		if (collidesAt(moving, x, y, others)) {
			firstHit = t;
			break;
		}
		lastFree = t;
	}
	if (firstHit < 0) return 1;
	let lo = lastFree;
	let hi = firstHit;
	for (let i = 0; i < 20; i++) {
		const mid = (lo + hi) / 2;
		const x = fromX + (toX - fromX) * mid;
		const y = fromY + (toY - fromY) * mid;
		if (collidesAt(moving, x, y, others)) hi = mid;
		else lo = mid;
	}
	return lo;
}

/**
 * Contact normal at (or just beyond) a touching position: the unit vector
 * pushing the moving shape's content away from the obstacle it is about to
 * hit. Probed a hair along the motion so a *touching* pair reads as the
 * contact pair. Null when nothing is in the way.
 */
function contactNormal(
	moving: SolverShape,
	pos: Point,
	direction: Point,
	others: readonly SolverShape[]
): Point | null {
	const len = Math.hypot(direction.x, direction.y);
	if (len === 0) return null;
	const eps = 0.5;
	const px = pos.x + (direction.x / len) * eps;
	const py = pos.y + (direction.y / len) * eps;
	const content = contentOf(moving, px, py);
	for (const other of others) {
		if (other.id === moving.id) continue;
		const target = contentOf(other, other.x, other.y);
		if (!intersects(content, target)) continue;
		return normalBetween(content, target);
	}
	return null;
}

/** Push-out normal from `target` toward `content`, per shape pair. */
function normalBetween(content: Content, target: Content): Point | null {
	if (content.kind === 'circle' && target.kind === 'circle') {
		return normalize(content.cx - target.cx, content.cy - target.cy);
	}
	if (content.kind === 'circle' && target.kind === 'rect') {
		const nx = Math.max(target.x, Math.min(content.cx, target.x + target.w));
		const ny = Math.max(target.y, Math.min(content.cy, target.y + target.h));
		return normalize(content.cx - nx, content.cy - ny) ?? { x: 0, y: -1 };
	}
	if (content.kind === 'rect' && target.kind === 'circle') {
		const nx = Math.max(content.x, Math.min(target.cx, content.x + content.w));
		const ny = Math.max(content.y, Math.min(target.cy, content.y + content.h));
		return normalize(nx - target.cx, ny - target.cy) ?? { x: 0, y: -1 };
	}
	if (content.kind === 'rect' && target.kind === 'rect') {
		// Axis of minimum overlap, signed by relative centers.
		const overlapX =
			Math.min(content.x + content.w, target.x + target.w) - Math.max(content.x, target.x);
		const overlapY =
			Math.min(content.y + content.h, target.y + target.h) - Math.max(content.y, target.y);
		const cxDelta = content.x + content.w / 2 - (target.x + target.w / 2);
		const cyDelta = content.y + content.h / 2 - (target.y + target.h / 2);
		return overlapX < overlapY
			? { x: Math.sign(cxDelta) || 1, y: 0 }
			: { x: 0, y: Math.sign(cyDelta) || 1 };
	}
	return null;
}

function normalize(x: number, y: number): Point | null {
	const len = Math.hypot(x, y);
	if (len < 1e-9) return null;
	return { x: x / len, y: y / len };
}

/**
 * Collide-and-slide (UX-OBJ-12): sweep to first contact, project the unspent
 * motion onto the contact tangent, and go again — so the dragged shape slides
 * along faces and curves around circles and corners instead of wedging. Up to
 * three passes: pass 2 handles pocket corners (a second normal); motion dies
 * only when contacts genuinely oppose it. The tangent is the SHAPE'S tangent
 * — a circle's contact normal rotates as you slide, which is what makes the
 * path curve around it.
 */
export function resolveMove(
	moving: SolverShape,
	desired: Point,
	others: readonly SolverShape[]
): Point {
	let pos: Point = { x: moving.x, y: moving.y };
	let remaining: Point = { x: desired.x - pos.x, y: desired.y - pos.y };

	for (let pass = 0; pass < 3; pass++) {
		if (Math.hypot(remaining.x, remaining.y) < 0.01) break;
		const t = maxFreeT(moving, pos.x, pos.y, pos.x + remaining.x, pos.y + remaining.y, others);
		pos = { x: pos.x + remaining.x * t, y: pos.y + remaining.y * t };
		if (t >= 1) break;
		const unspent: Point = { x: remaining.x * (1 - t), y: remaining.y * (1 - t) };
		const normal = contactNormal(moving, pos, unspent, others);
		if (normal === null) break;
		const dot = unspent.x * normal.x + unspent.y * normal.y;
		remaining = { x: unspent.x - dot * normal.x, y: unspent.y - dot * normal.y };
	}
	return pos;
}

/** Commit-side check (AR-CANVAS-5 server pass): is this placement legal at all? */
export function placementLegal(shape: SolverShape, others: readonly SolverShape[]): boolean {
	return !collidesAt(shape, shape.x, shape.y, others);
}

/**
 * Placement resolution for arrivals (AR-CTRL-4's shape): desired spot if
 * legal, else scan outward in a spiral of grid steps until a legal spot is
 * found. Deterministic; the real algorithm is a named open item.
 */
export function nearestLegal(shape: SolverShape, others: readonly SolverShape[], step = 24): Point {
	if (placementLegal(shape, others)) return { x: shape.x, y: shape.y };
	for (let ring = 1; ring <= 40; ring++) {
		for (let dx = -ring; dx <= ring; dx++) {
			for (const dy of dx === -ring || dx === ring ? rangeInclusive(-ring, ring) : [-ring, ring]) {
				const candidate = { ...shape, x: shape.x + dx * step, y: shape.y + dy * step };
				if (placementLegal(candidate, others)) return { x: candidate.x, y: candidate.y };
			}
		}
	}
	return { x: shape.x, y: shape.y };
}

function rangeInclusive(a: number, b: number): number[] {
	const out: number[] = [];
	for (let i = a; i <= b; i++) out.push(i);
	return out;
}
