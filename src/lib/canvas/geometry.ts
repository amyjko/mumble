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

/** A convex polygon in world coordinates, already rotated. */
interface ContentPoly {
	kind: 'poly';
	vertices: Point[];
}

type Content = ContentCircle | ContentPoly;

/** Ellipse tessellation detail — enough that the seam is invisible at any zoom. */
const ELLIPSE_SEGMENTS = 16;

function rotatePoint(x: number, y: number, cx: number, cy: number, radians: number): Point {
	if (radians === 0) return { x, y };
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const dx = x - cx;
	const dy = y - cy;
	return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/**
 * The shape's COLLIDABLE content: its silhouette inset by the sticker border
 * (the border width is the permitted overlap, UX-OBJ-12) and rotated.
 *
 * Percentage outlines are mapped onto the inset box, which is exactly how the
 * renderer draws the content layer — so the collider and the pixels agree by
 * construction rather than by coincidence.
 */
function contentOf(s: SolverShape, x: number, y: number): Content {
	const cx = x + s.width / 2;
	const cy = y + s.height / 2;
	if (s.circle) {
		// Rotation-invariant, so it needs no rotation term at all.
		const r = Math.max(0, Math.min(s.width, s.height) / 2 - s.border);
		return { kind: 'circle', cx, cy, r };
	}

	const inset = Math.min(s.border, s.width / 2, s.height / 2);
	const left = x + inset;
	const top = y + inset;
	const w = s.width - inset * 2;
	const h = s.height - inset * 2;
	const radians = (s.rotation * Math.PI) / 180;

	const local: { x: number; y: number }[] =
		s.points === undefined
			? [
					{ x: 0, y: 0 },
					{ x: 100, y: 0 },
					{ x: 100, y: 100 },
					{ x: 0, y: 100 }
				]
			: [...s.points];

	return {
		kind: 'poly',
		vertices: local.map((p) =>
			rotatePoint(left + (p.x / 100) * w, top + (p.y / 100) * h, cx, cy, radians)
		)
	};
}

/** An ellipse inscribed in the box, as percentage points. */
export function ellipsePoints(segments = ELLIPSE_SEGMENTS): { x: number; y: number }[] {
	const out: { x: number; y: number }[] = [];
	for (let i = 0; i < segments; i++) {
		const t = (i / segments) * Math.PI * 2;
		out.push({ x: 50 + 50 * Math.cos(t), y: 50 + 50 * Math.sin(t) });
	}
	return out;
}

/** Project a polygon onto an axis, returning [min, max]. */
function projectPoly(vertices: readonly Point[], axis: Point): [number, number] {
	let min = Infinity;
	let max = -Infinity;
	for (const v of vertices) {
		const d = v.x * axis.x + v.y * axis.y;
		if (d < min) min = d;
		if (d > max) max = d;
	}
	return [min, max];
}

/** Candidate separating axes: the outward normal of every edge. */
function edgeAxes(vertices: readonly Point[]): Point[] {
	const axes: Point[] = [];
	for (let i = 0; i < vertices.length; i++) {
		const a = vertices[i];
		const b = vertices[(i + 1) % vertices.length];
		if (a === undefined || b === undefined) continue;
		const normal = normalize(-(b.y - a.y), b.x - a.x);
		if (normal !== null) axes.push(normal);
	}
	return axes;
}

function nearestVertex(vertices: readonly Point[], px: number, py: number): Point | null {
	let best: Point | null = null;
	let bestDistance = Infinity;
	for (const v of vertices) {
		const d = (v.x - px) ** 2 + (v.y - py) ** 2;
		if (d < bestDistance) {
			bestDistance = d;
			best = v;
		}
	}
	return best;
}

/**
 * Separating Axis Theorem overlap, returning the minimum translation vector
 * (the axis and depth of least penetration) or null when disjoint.
 *
 * The MTV falls out of the same loop that decides overlap, which is why
 * `normalBetween` below is now a thin wrapper rather than a pile of per-pair
 * special cases — the old rect/rect branch could only ever emit an
 * axis-aligned normal, which is wrong the moment anything is rotated.
 */
function separation(a: Content, b: Content): { axis: Point; depth: number } | null {
	if (a.kind === 'circle' && b.kind === 'circle') {
		const dx = a.cx - b.cx;
		const dy = a.cy - b.cy;
		const distance = Math.hypot(dx, dy);
		const overlap = a.r + b.r - distance;
		if (overlap <= 0) return null;
		return { axis: normalize(dx, dy) ?? { x: 0, y: -1 }, depth: overlap };
	}

	const poly = a.kind === 'poly' ? a : b.kind === 'poly' ? b : null;
	const circle = a.kind === 'circle' ? a : b.kind === 'circle' ? b : null;

	if (poly !== null && circle !== null) {
		// Polygon edge normals, plus the axis toward the closest vertex — the
		// case that catches a circle nestled against a corner.
		const axes = edgeAxes(poly.vertices);
		const near = nearestVertex(poly.vertices, circle.cx, circle.cy);
		if (near !== null) {
			const toward = normalize(circle.cx - near.x, circle.cy - near.y);
			if (toward !== null) axes.push(toward);
		}
		let best: { axis: Point; depth: number } | null = null;
		for (const axis of axes) {
			const [minP, maxP] = projectPoly(poly.vertices, axis);
			const centre = circle.cx * axis.x + circle.cy * axis.y;
			const overlap = Math.min(maxP - (centre - circle.r), centre + circle.r - minP);
			if (overlap <= 0) return null;
			if (best === null || overlap < best.depth) best = { axis, depth: overlap };
		}
		if (best === null) return null;
		// Orient the axis so it pushes `a` away from `b`.
		const sign = a.kind === 'circle' ? 1 : -1;
		const centreDelta =
			(circle.cx - polyCentroid(poly).x) * best.axis.x +
			(circle.cy - polyCentroid(poly).y) * best.axis.y;
		const orient = centreDelta * sign >= 0 ? 1 : -1;
		return { axis: { x: best.axis.x * orient, y: best.axis.y * orient }, depth: best.depth };
	}

	if (a.kind !== 'poly' || b.kind !== 'poly') return null;
	const axes = [...edgeAxes(a.vertices), ...edgeAxes(b.vertices)];
	let best: { axis: Point; depth: number } | null = null;
	for (const axis of axes) {
		const [minA, maxA] = projectPoly(a.vertices, axis);
		const [minB, maxB] = projectPoly(b.vertices, axis);
		const overlap = Math.min(maxA - minB, maxB - minA);
		if (overlap <= 0) return null;
		if (best === null || overlap < best.depth) best = { axis, depth: overlap };
	}
	if (best === null) return null;
	const ca = polyCentroid(a);
	const cb = polyCentroid(b);
	const orient = (ca.x - cb.x) * best.axis.x + (ca.y - cb.y) * best.axis.y >= 0 ? 1 : -1;
	return { axis: { x: best.axis.x * orient, y: best.axis.y * orient }, depth: best.depth };
}

function polyCentroid(poly: ContentPoly): Point {
	let x = 0;
	let y = 0;
	for (const v of poly.vertices) {
		x += v.x;
		y += v.y;
	}
	const n = poly.vertices.length || 1;
	return { x: x / n, y: y / n };
}

function intersects(a: Content, b: Content): boolean {
	return separation(a, b) !== null;
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

/**
 * Push-out normal from `target` toward `content` — now just the direction of
 * the SAT minimum translation vector, for every shape pair at once. The old
 * version enumerated pairs by hand and its rect/rect branch could only ever
 * return an axis-aligned normal, so a rotated object slid along the wrong
 * direction.
 */
function normalBetween(content: Content, target: Content): Point | null {
	return separation(content, target)?.axis ?? null;
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
 * Drag resolution WITH teleport-through (UX-OBJ-12).
 *
 * If the desired position is itself legal, go there — even when the straight
 * path to it is blocked. Sliding alone turned the canvas into a minefield: to
 * put a note on the far side of a cluster you had to steer a continuous path
 * through the gaps, and a fully enclosed pocket had no path at all.
 *
 * This is NOT flickery despite running every frame, because the outcome is a
 * pure function of where the cursor is: legal cursor position means the object
 * is under the cursor, and only when the cursor lands somewhere illegal does
 * the slide solver take over. Nothing depends on the path taken to get there.
 *
 * `resolveMove` is kept as the constrained-path primitive underneath, so the
 * "every intermediate position is legal" invariant still has a home and its
 * tests still mean something.
 */
export function resolveDrag(
	moving: SolverShape,
	desired: Point,
	others: readonly SolverShape[]
): Point {
	if (placementLegal({ ...moving, x: desired.x, y: desired.y }, others)) return desired;
	return resolveMove(moving, desired, others);
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
