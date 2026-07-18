import { describe, expect, it } from 'vitest';
import { MIN_SIZE, resizeTransform, rotationForPointer, snapRotation } from './resize';
import type { Transform } from '$lib/model/types';

const t: Transform = { x: 100, y: 100, width: 200, height: 160, rotation: 0, z: 1 };

describe('resize (UX-OBJ-1)', () => {
	it('se handle grows width/height, anchoring the top-left', () => {
		const r = resizeTransform(t, 'se', 50, 40);
		expect(r).toMatchObject({ x: 100, y: 100, width: 250, height: 200 });
	});

	it('nw handle moves the origin and shrinks, anchoring the bottom-right', () => {
		const r = resizeTransform(t, 'nw', 20, 10);
		expect(r.width).toBe(180);
		expect(r.height).toBe(150);
		expect(r.x).toBe(120);
		expect(r.y).toBe(110);
		expect(r.x + r.width).toBe(t.x + t.width); // bottom-right fixed
	});

	it('clamps to the minimum size, keeping the fixed edge fixed', () => {
		const r = resizeTransform(t, 'nw', 1000, 1000);
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
	it('snaps to 15° steps only when asked', () => {
		expect(snapRotation(40, true)).toBe(45);
		expect(snapRotation(37, true)).toBe(30); // 37 is nearer 30 than 45
		expect(snapRotation(37, false)).toBe(37);
		expect(snapRotation(-15, true)).toBe(345);
	});
});
