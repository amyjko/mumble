import { describe, expect, it } from 'vitest';
import { ellipsePoints, fitAll, nearestLegal, placementLegal, resolveDrag, resolveMove, screenToWorld, unionBounds, worldToScreen, zoomAt } from './geometry';
import type { SolverShape } from '$lib/model/types';

const rect = (id: string, x: number, y: number, size = 100, border = 10, rotation = 0): SolverShape => ({
	id,
	x,
	y,
	width: size,
	height: size,
	rotation,
	circle: false,
	border
});

const circle = (id: string, x: number, y: number, size = 100, border = 10): SolverShape => ({
	id,
	x,
	y,
	width: size,
	height: size,
	rotation: 0,
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

describe('resolveDrag: teleport-through (UX-OBJ-12)', () => {
	const box = (id: string, x: number, y: number): SolverShape => ({
		id,
		x,
		y,
		width: 100,
		height: 100,
		rotation: 0,
		circle: false,
		border: 0
	});

	it('jumps past a blocker when the destination itself is free', () => {
		// A wall between start and target. Sliding alone could never arrive:
		// there is no continuous legal path straight through.
		const moving = box('m', 0, 0);
		const wall = box('w', 150, 0);
		const target = { x: 300, y: 0 };
		const landed = resolveDrag(moving, target, [wall]);
		expect(landed).toEqual(target);
		// And the arrival is legal, so the store will accept it.
		expect(placementLegal({ ...moving, ...landed }, [wall])).toBe(true);
	});

	it('falls back to sliding when the destination is occupied', () => {
		const moving = box('m', 0, 0);
		const wall = box('w', 150, 0);
		// Aim INTO the wall: no teleport, and the slide stops short of overlap.
		const landed = resolveDrag(moving, { x: 150, y: 0 }, [wall]);
		expect(landed).not.toEqual({ x: 150, y: 0 });
		expect(placementLegal({ ...moving, ...landed }, [wall])).toBe(true);
	});

	it('escapes a fully enclosed pocket, which sliding never could', () => {
		// Boxed in on all four sides: every continuous path is blocked, so this
		// is the case that motivated teleporting rather than only sliding.
		const moving = box('m', 0, 0);
		const pocket = [box('n', 0, -110), box('s', 0, 110), box('w', -110, 0), box('e', 110, 0)];
		const target = { x: 600, y: 600 };
		expect(resolveDrag(moving, target, pocket)).toEqual(target);
	});
});

describe('rotated collision (SAT / OBB)', () => {
	it('a rotated square occupies its DIAGONAL, not its bounding box', () => {
		// The classic case the axis-aligned solver got wrong. A 100px square
		// turned 45° reaches ~71px along each axis from its centre, so a
		// neighbour that clears the unrotated box can still be struck.
		const spinner = rect('a', 0, 0, 100, 0, 45);
		// Directly right, with a gap that an UNROTATED square would clear.
		const neighbour = rect('b', 115, 0, 100, 0, 0);
		expect(placementLegal(spinner, [neighbour])).toBe(false);
	});

	it('the same pair is legal when the square is NOT rotated', () => {
		// Same geometry, rotation zero: proves the previous case is about
		// rotation and not about the gap being too small in general.
		const still = rect('a', 0, 0, 100, 0, 0);
		const neighbour = rect('b', 115, 0, 100, 0, 0);
		expect(placementLegal(still, [neighbour])).toBe(true);
	});

	it('rotation is periodic: 90° on a square is the same as 0°', () => {
		const neighbour = rect('b', 115, 0, 100, 0, 0);
		expect(placementLegal(rect('a', 0, 0, 100, 0, 90), [neighbour])).toBe(true);
		expect(placementLegal(rect('a', 0, 0, 100, 0, 180), [neighbour])).toBe(true);
	});

	it('slides along a rotated face rather than an axis', () => {
		// Pushed straight into a 45° wall, the leftover motion must run ALONG
		// the wall — the old min-overlap-axis normal could only ever be
		// axis-aligned, so it slid the wrong way against anything rotated.
		const moving = rect('m', 0, 0, 60, 0, 0);
		const wall = rect('w', 0, 120, 200, 0, 45);
		const landed = resolveMove(moving, { x: 0, y: 200 }, [wall]);
		expect(placementLegal({ ...moving, ...landed }, [wall])).toBe(true);
		// It deflected sideways instead of stopping dead against the face.
		expect(Math.abs(landed.x)).toBeGreaterThan(1);
	});
});

describe('polygon colliders (not bounding boxes)', () => {
	const hexagon = [
		{ x: 25, y: 0 },
		{ x: 75, y: 0 },
		{ x: 100, y: 50 },
		{ x: 75, y: 100 },
		{ x: 25, y: 100 },
		{ x: 0, y: 50 }
	];

	const poly = (id: string, x: number, y: number): SolverShape => ({
		id,
		x,
		y,
		width: 100,
		height: 100,
		rotation: 0,
		circle: false,
		points: hexagon,
		border: 0
	});

	it('lets two hexagons nest at their cut corners', () => {
		// Both bounding boxes overlap heavily here. Only a real polygon
		// collider sees that the angled corners leave the shapes disjoint —
		// this exact placement was a false collision before.
		const a = poly('a', 0, 0);
		const b = poly('b', 88, 55);
		expect(placementLegal(a, [b])).toBe(true);
	});

	it('still reports a genuine overlap of the polygon bodies', () => {
		const a = poly('a', 0, 0);
		const b = poly('b', 20, 0);
		expect(placementLegal(a, [b])).toBe(false);
	});

	it('an ellipse is not its bounding box either', () => {
		// Corner-to-corner: the boxes touch, the inscribed ellipses do not.
		const ellipse = (id: string, x: number, y: number): SolverShape => ({
			id,
			x,
			y,
			width: 100,
			height: 100,
			rotation: 0,
			circle: false,
			points: ellipsePoints(),
			border: 0
		});
		expect(placementLegal(ellipse('a', 0, 0), [ellipse('b', 92, 92)])).toBe(true);
	});
});

/**
 * SAT is the hot loop: it runs per sampled step, per obstacle, per frame of a
 * drag. Measured when rotation and polygon support landed — a realistic
 * per-frame delta against 40 rotated obstacles cost ~0.03ms, about 0.2% of a
 * 16ms frame. The bound here is deliberately loose (machines differ); it exists
 * to catch an ORDER-OF-MAGNITUDE regression, not to police jitter.
 */
describe('solver performance', () => {
	const crowd = (): SolverShape[] => {
		const out: SolverShape[] = [];
		for (let i = 0; i < 40; i++) {
			out.push({
				id: `o${String(i)}`,
				x: (i % 8) * 160,
				y: Math.floor(i / 8) * 160,
				width: 120,
				height: 120,
				rotation: i * 7,
				circle: i % 3 === 0,
				border: 10
			});
		}
		return out;
	};

	it('a per-frame drag step stays far inside a frame budget', () => {
		const others = crowd();
		const moving: SolverShape = {
			id: 'm', x: 300, y: 300, width: 120, height: 120, rotation: 20, circle: false, border: 10
		};
		const runs = 500;
		const start = performance.now();
		for (let i = 0; i < runs; i++) resolveMove(moving, { x: 308, y: 306 }, others);
		const perCall = (performance.now() - start) / runs;
		expect(perCall).toBeLessThan(1);
	});
});
