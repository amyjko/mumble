import { describe, expect, it } from 'vitest';
import {
	fitAll,
	nearestLegal,
	placementLegal,
	resolveMove,
	screenToWorld,
	unionBounds,
	worldToScreen,
	zoomAt
} from './geometry';
import type { SolverShape } from '$lib/model/types';

const rect = (id: string, x: number, y: number, size = 100, border = 10): SolverShape => ({
	id,
	x,
	y,
	width: size,
	height: size,
	circle: false,
	border
});

const circle = (id: string, x: number, y: number, size = 100, border = 10): SolverShape => ({
	id,
	x,
	y,
	width: size,
	height: size,
	circle: true,
	border
});

describe('screen↔world', () => {
	it('round-trips through a scaled, translated camera', () => {
		const camera = { x: 120, y: -40, scale: 2.5 };
		const p = { x: 333, y: 217 };
		const back = worldToScreen(screenToWorld(p, camera), camera);
		expect(back.x).toBeCloseTo(p.x);
		expect(back.y).toBeCloseTo(p.y);
	});

	it('zoomAt keeps the world point under the cursor fixed', () => {
		const camera = { x: 0, y: 0, scale: 1 };
		const cursor = { x: 400, y: 300 };
		const before = screenToWorld(cursor, camera);
		const after = screenToWorld(cursor, zoomAt(camera, cursor, 2));
		expect(after.x).toBeCloseTo(before.x);
		expect(after.y).toBeCloseTo(before.y);
	});
});

describe('fitAll (UX-CANVAS-3)', () => {
	it('fits content inside the viewport with padding', () => {
		const content = { x: -500, y: -500, width: 1000, height: 1000 };
		const viewport = { width: 800, height: 600 };
		const camera = fitAll(content, viewport);
		const topLeft = worldToScreen({ x: -500, y: -500 }, camera);
		const bottomRight = worldToScreen({ x: 500, y: 500 }, camera);
		expect(topLeft.x).toBeGreaterThanOrEqual(0);
		expect(topLeft.y).toBeGreaterThanOrEqual(0);
		expect(bottomRight.x).toBeLessThanOrEqual(800);
		expect(bottomRight.y).toBeLessThanOrEqual(600);
	});

	it('unionBounds of nothing is null', () => {
		expect(unionBounds([])).toBeNull();
	});
});

describe('overlap solver (UX-OBJ-12, AR-CANVAS-5)', () => {
	it('free movement is unconstrained', () => {
		const moved = resolveMove(rect('a', 0, 0), { x: 500, y: 500 }, [rect('b', 900, 900)]);
		expect(moved).toEqual({ x: 500, y: 500 });
	});

	it('stops at contact: borders may overlap, content may not', () => {
		// Two 100-wide rects, border 10 each: contents are inset 10, so centers
		// may approach until outer rects overlap by 20 — i.e. dx = 80.
		const moved = resolveMove(rect('a', 0, 0), { x: 400, y: 0 }, [rect('b', 180, 0)]);
		expect(moved.x).toBeCloseTo(100, 0); // 180 - 80 = 100: contents just touch
		expect(moved.y).toBe(0);
	});

	it('slides along the boundary instead of sticking', () => {
		// Diagonal push into a neighbor directly to the right: x clamps at
		// contact, y keeps the full requested movement.
		const moved = resolveMove(rect('a', 0, 0), { x: 200, y: 60 }, [rect('b', 120, 0)]);
		expect(moved.x).toBeLessThan(200);
		expect(moved.y).toBeCloseTo(60, 0);
	});

	it('a zero-border object gets zero tolerance (UX-OBJ-12 edge case)', () => {
		const a = rect('a', 0, 0, 100, 0);
		const b = rect('b', 150, 0, 100, 0);
		const moved = resolveMove(a, { x: 400, y: 0 }, [b]);
		expect(moved.x).toBeCloseTo(50, 0); // outer edges just touch
	});

	it('circles do not reserve their corners (clip-aware collision)', () => {
		// A circle sliding diagonally past a rect's corner region: with square
		// bounds the move would clamp, but circle content clears it.
		const c = circle('c', 0, 0, 100, 0);
		const obstacle = rect('r', 90, 90, 100, 0);
		const moved = resolveMove(c, { x: 55, y: 55 }, [obstacle]);
		const cx = moved.x + 50;
		const cy = moved.y + 50;
		const nx = Math.max(90, Math.min(cx, 190));
		const ny = Math.max(90, Math.min(cy, 190));
		expect(Math.hypot(cx - nx, cy - ny)).toBeGreaterThanOrEqual(49.9);
	});

	it('placementLegal rejects content overlap and admits border overlap', () => {
		expect(placementLegal(rect('a', 0, 0), [rect('b', 85, 0)])).toBe(true); // borders only
		expect(placementLegal(rect('a', 0, 0), [rect('b', 50, 0)])).toBe(false); // content
	});

	it('tangent slide: diagonal push against a flat face keeps the tangent component', () => {
		// Pushing 45° into a wall directly right: x stops at contact, the y
		// (tangent) component survives in full — no pinning.
		const moved = resolveMove(rect('a', 0, 0), { x: 300, y: 120 }, [rect('b', 120, 0)]);
		expect(moved.x).toBeLessThan(120);
		expect(moved.y).toBeCloseTo(120, 0);
	});

	it('tangent slide: a circle curves around a circle, never penetrating', () => {
		// Drag a circle straight through another that is slightly offset from
		// the path: the contact normal rotates as it slides, so it rounds the
		// obstacle and continues, and every intermediate position is legal.
		const obstacle = circle('b', 200, 20, 100, 0);
		let shape = circle('a', 0, 0, 100, 0);
		const targetX = 420;
		for (let step = 0; step < 40; step++) {
			const desired = { x: shape.x + (targetX - shape.x) / 4 + 12, y: shape.y };
			const next = resolveMove(shape, desired, [obstacle]);
			shape = { ...shape, x: next.x, y: next.y };
			expect(placementLegal(shape, [obstacle])).toBe(true);
		}
		// It made it past the obstacle by going around, not through.
		expect(shape.x).toBeGreaterThan(240);
	});

	it('pocket corner: straight-in push stops; angled push slides out along a wall', () => {
		// Two walls forming a 90° pocket opening up-left; object sits inside.
		const walls = [rect('w1', 120, 0, 200, 0), rect('w2', 0, 120, 200, 0)];
		const straight = resolveMove(rect('a', 0, 0, 100, 0), { x: 200, y: 200 }, walls);
		expect(straight.x).toBeLessThanOrEqual(20.5);
		expect(straight.y).toBeLessThanOrEqual(20.5);
		// Angled mostly-leftward push escapes along the top wall.
		const angled = resolveMove(rect('a', 0, 0, 100, 0), { x: -300, y: 60 }, walls);
		expect(angled.x).toBeLessThan(-100);
	});

	it('nearestLegal finds a free spot deterministically', () => {
		const others = [rect('b', 0, 0), rect('c', 100, 0), rect('d', 0, 100)];
		const spot = nearestLegal(rect('a', 0, 0), others);
		expect(placementLegal({ ...rect('a', 0, 0), x: spot.x, y: spot.y }, others)).toBe(true);
	});
});
