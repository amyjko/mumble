import { describe, expect, it } from 'vitest';
import { MIN_SIZE, SNAP_GRID, minSizeFor, resizeTransform, rotationForPointer, snapRotation, snapTo } from './resize';
import type { Transform } from '$lib/model/types';

const t: Transform = { x: 100, y: 100, width: 200, height: 160, rotation: 0, z: 1 };

/**
 * Snapping is the DEFAULT now; Shift asks for precision. These two names say
 * which is which at each call, because `true`/`false` read identically before
 * and after the inversion and would have quietly kept asserting the old rule.
 */
const SNAPPED = { precise: false };
const PRECISE = { precise: true };

describe('resize (UX-OBJ-1)', () => {
	it('se handle grows width/height, anchoring the top-left', () => {
		const r = resizeTransform(t, 'se', 50, 40, PRECISE);
		expect(r).toMatchObject({ x: 100, y: 100, width: 250, height: 200 });
	});

	it('nw handle moves the origin and shrinks, anchoring the bottom-right', () => {
		const r = resizeTransform(t, 'nw', 20, 10, PRECISE);
		expect(r.width).toBe(180);
		expect(r.height).toBe(150);
		expect(r.x).toBe(120);
		expect(r.y).toBe(110);
		expect(r.x + r.width).toBe(t.x + t.width); // bottom-right fixed
	});

	it('clamps to the minimum size, keeping the fixed edge fixed', () => {
		const r = resizeTransform(t, 'nw', 1000, 1000, PRECISE);
		expect(r.width).toBe(MIN_SIZE);
		expect(r.height).toBe(MIN_SIZE);
		expect(r.x + r.width).toBe(t.x + t.width);
		expect(r.y + r.height).toBe(t.y + t.height);
	});
});

describe('rotate (UX-OBJ-1)', () => {
	it('pointer directly above the center is 0°', () => {
		expect(rotationForPointer({ x: 0, y: 0 }, { x: 0, y: -100 })).toBe(0);
	});
	it('pointer to the right is 90°', () => {
		expect(rotationForPointer({ x: 0, y: 0 }, { x: 100, y: 0 })).toBe(90);
	});
	it('snaps to 15° steps unless precision is asked for', () => {
		expect(snapRotation(40, SNAPPED)).toBe(45);
		expect(snapRotation(37, SNAPPED)).toBe(30); // 37 is nearer 30 than 45
		expect(snapRotation(37, PRECISE)).toBe(37);
		expect(snapRotation(-15, SNAPPED)).toBe(345);
	});
});

describe('snapping is the default; Shift asks for precision', () => {
	const t: Transform = { x: 100, y: 100, width: 200, height: 160, rotation: 0, z: 1 };

	it('snapTo quantizes unless precision is asked for', () => {
		expect(snapTo(103, SNAPPED)).toBe(96); // 103/16 = 6.44 -> 6 -> 96
		expect(snapTo(112, SNAPPED)).toBe(112); // already on the lattice (16 x 7)
		expect(snapTo(104, SNAPPED)).toBe(112); // exact midpoint rounds up
		expect(snapTo(105, SNAPPED)).toBe(112); // 105/16 = 6.56 -> 7 -> 112
		expect(snapTo(103, PRECISE)).toBe(103);
		expect(snapTo(-9, SNAPPED)).toBe(-16);
	});

	it('snaps the SIZE and keeps the anchored corner exactly put', () => {
		// Dragging se: the nw corner is the anchor and must not move at all.
		const r = resizeTransform(t, 'se', 7, 5, SNAPPED);
		expect(r.width % SNAP_GRID).toBe(0);
		expect(r.height % SNAP_GRID).toBe(0);
		expect(r.x).toBe(t.x);
		expect(r.y).toBe(t.y);
	});

	it('snapping from nw moves the edge but pins the opposite corner', () => {
		// The anchor is the se corner. Snapping x/y directly (rather than
		// deriving them from a snapped size) would drift it off the object.
		const r = resizeTransform(t, 'nw', 7, 5, SNAPPED);
		expect(r.width % SNAP_GRID).toBe(0);
		expect(r.height % SNAP_GRID).toBe(0);
		expect(r.x + r.width).toBe(t.x + t.width);
		expect(r.y + r.height).toBe(t.y + t.height);
	});
});

describe('per-type minimum sizes', () => {
	const t: Transform = { x: 100, y: 100, width: 200, height: 160, rotation: 0, z: 1 };

	it('gives control-bearing types room for their controls', () => {
		// A flat 40px floor let a timer be shrunk until .content clipped its own
		// start/reset buttons away — unusable, with no pointer route back.
		expect(minSizeFor('timer').height).toBeGreaterThan(MIN_SIZE);
		expect(minSizeFor('chat').height).toBeGreaterThan(MIN_SIZE);
		expect(minSizeFor('note').height).toBeGreaterThan(MIN_SIZE);
		// A drawing carries no controls, so the flat floor is right for it.
		expect(minSizeFor('drawing')).toEqual({ width: MIN_SIZE, height: MIN_SIZE });
	});

	it('resizeTransform refuses to go below the type floor', () => {
		const timerMin = minSizeFor('timer');
		// Drag the se handle far past zero.
		const r = resizeTransform(t, 'se', -9999, -9999, PRECISE, timerMin);
		expect(r.width).toBe(timerMin.width);
		expect(r.height).toBe(timerMin.height);
	});
});
