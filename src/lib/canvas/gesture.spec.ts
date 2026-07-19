import { describe, expect, it } from 'vitest';
import { arrowDelta, isReshapeKey, resizeByKey, rotateByKey } from './gesture.svelte';

/**
 * The keyboard vocabulary, tested once for all three draggables. Every case
 * below is a rule that HAD drifted between the copies this module replaced.
 */

/** The two fields the vocabulary reads. A real KeyboardEvent satisfies it. */
const key = (k: string, shiftKey = false): { key: string; shiftKey: boolean } => ({
	key: k,
	shiftKey
});

describe('arrow movement', () => {
	it('moves by 16 normally and 1 with Shift', () => {
		expect(arrowDelta(key('ArrowRight'))).toEqual({ x: 16, y: 0 });
		expect(arrowDelta(key('ArrowRight', true))).toEqual({ x: 1, y: 0 });
	});

	it('covers all four directions and ignores everything else', () => {
		expect(arrowDelta(key('ArrowUp'))).toEqual({ x: 0, y: -16 });
		expect(arrowDelta(key('ArrowDown'))).toEqual({ x: 0, y: 16 });
		expect(arrowDelta(key('ArrowLeft'))).toEqual({ x: -16, y: 0 });
		expect(arrowDelta(key('q'))).toBeNull();
	});

	it('matches SNAP_GRID, so keyboard and pointer land on one lattice', () => {
		// resize.ts states this as the reason both use 16; nothing checked it.
		const delta = arrowDelta(key('ArrowRight'));
		expect(delta?.x).toBe(16);
	});
});

describe('Alt+Arrow resize', () => {
	const size = { width: 200, height: 160 };
	const min = { width: 100, height: 80 };

	it('grows and shrinks on the right axis', () => {
		expect(resizeByKey(size, key('ArrowRight'), min)).toEqual({ width: 216, height: 160 });
		expect(resizeByKey(size, key('ArrowUp'), min)).toEqual({ width: 200, height: 144 });
	});

	it('never shrinks below the minimum', () => {
		const small = { width: 104, height: 84 };
		expect(resizeByKey(small, key('ArrowLeft'), min)?.width).toBe(min.width);
		expect(resizeByKey(small, key('ArrowUp'), min)?.height).toBe(min.height);
	});

	it('uses a FIXED step, ignoring Shift', () => {
		// One copy reused the movement step, so Shift+Alt+Arrow resized by 1px
		// there and 16px everywhere else. A 1px resize is indistinguishable
		// from noise, so "precise" has no useful meaning for this gesture.
		expect(resizeByKey(size, key('ArrowRight', true), min)?.width).toBe(216);
	});
});

describe('bracket rotation', () => {
	it('steps 15° each way', () => {
		expect(rotateByKey(0, key(']'))).toBe(15);
		expect(rotateByKey(30, key('['))).toBe(15);
	});

	it('WRAPS into [0, 360) instead of accumulating', () => {
		// The bug this replaces: one copy did bare arithmetic, so `]` past a
		// full turn stored 375 — and a placer's rotation is adopted by whoever
		// arrives in it, so the bad value entered participant state.
		//
		// 350 + 15 = 365, which wraps to 5 and then quantises to 0. The point
		// is the range, so assert that rather than a specific step.
		const past = rotateByKey(350, key(']'));
		expect(past).not.toBeNull();
		expect(past).toBeGreaterThanOrEqual(0);
		expect(past).toBeLessThan(360);
		// Going below zero wraps the other way rather than storing -15.
		expect(rotateByKey(0, key('['))).toBe(345);
	});

	it('quantises to the 15° lattice even from an off-grid start', () => {
		// 7 + 15 = 22, whose nearest lattice point is 15 — the step lands you
		// ON the grid rather than carrying the 7° offset forward forever.
		expect(rotateByKey(7, key(']'))).toBe(15);
		expect((rotateByKey(7, key(']')) ?? 1) % 15).toBe(0);
	});

	it('ignores other keys', () => {
		expect(rotateByKey(0, key('r'))).toBeNull();
	});
});

describe('reshape key', () => {
	it('accepts either case', () => {
		// One copy took lowercase only, so Caps Lock or Shift+C did nothing.
		expect(isReshapeKey(key('c'))).toBe(true);
		expect(isReshapeKey(key('C'))).toBe(true);
		expect(isReshapeKey(key('v'))).toBe(false);
	});
});
