import { describe, expect, it } from 'vitest';
import {
	ARRIVED_EPSILON,
	CATCH_UP_MS,
	hasArrived,
	Interpolator,
	smoothPoint,
	smoothStep
} from './interpolate';

/**
 * Interpolation of peers' drags (AR-BACKEND-5), tested as pure logic per
 * AR-TEST-4 — no DOM, no rAF, no fake clock, because `advance` takes its own
 * `now`.
 */

describe('smoothStep', () => {
	it('moves toward the target without reaching it in one step', () => {
		const next = smoothStep(0, 100, 16);
		expect(next).toBeGreaterThan(0);
		expect(next).toBeLessThan(100);
	});

	it('never overshoots, even for an absurdly long frame', () => {
		expect(smoothStep(0, 100, 100_000)).toBeLessThanOrEqual(100);
		expect(smoothStep(100, 0, 100_000)).toBeGreaterThanOrEqual(0);
	});

	/**
	 * The property the whole approach rests on. A per-frame constant factor
	 * would make speed depend on refresh rate — the same code feeling different
	 * on a 120Hz display and a loaded one — so this is the regression that
	 * matters most if anyone "simplifies" the exponential away.
	 */
	it('is frame-rate independent: two half-steps land where one whole step does', () => {
		const once = smoothStep(0, 100, 16);
		const twice = smoothStep(smoothStep(0, 100, 8), 100, 8);
		expect(twice).toBeCloseTo(once, 10);
	});

	it('converges faster with a smaller time constant', () => {
		expect(smoothStep(0, 100, 16, 30)).toBeGreaterThan(smoothStep(0, 100, 16, 300));
	});

	it('does nothing for a zero or negative frame', () => {
		expect(smoothStep(5, 100, 0)).toBe(5);
		expect(smoothStep(5, 100, -16)).toBe(5);
	});

	it('reaches a target that is already current', () => {
		expect(smoothStep(42, 42, 16)).toBe(42);
	});
});

describe('hasArrived', () => {
	it('is true only within epsilon on BOTH axes', () => {
		expect(hasArrived({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(true);
		expect(hasArrived({ x: 0, y: 0 }, { x: ARRIVED_EPSILON / 2, y: 0 })).toBe(true);
		// One axis close and the other far is NOT arrival — the bug a naive
		// distance-on-x check would ship.
		expect(hasArrived({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe(false);
	});
});

describe('Interpolator', () => {
	/** Run frames at a steady 16ms until a predicate holds, or give up. */
	function run(interp: Interpolator, frames: number, from = 1000): { x: number; y: number }[] {
		const seen: { x: number; y: number }[] = [];
		let now = from;
		for (let i = 0; i < frames; i += 1) {
			now += 16;
			for (const step of interp.advance(now)) seen.push(step.at);
		}
		return seen;
	}

	it('reports nothing on the first frame, having no honest dt yet', () => {
		const interp = new Interpolator();
		interp.towards('a', { x: 100, y: 100 });
		expect(interp.advance(1000)).toEqual([]);
	});

	/**
	 * A backgrounded tab produces a multi-second gap between frames. Without
	 * resetting the clock, the first frame back would apply that whole gap and
	 * teleport every tracked object — the exact jump this module exists to
	 * prevent.
	 */
	it('does not apply a huge dt after an idle gap', () => {
		const interp = new Interpolator();
		interp.towards('a', { x: 0, y: 0 });
		interp.advance(1000);
		interp.towards('a', { x: 100, y: 0 });

		// A 30-second gap is the clock restarting, not a frame: it moves nothing
		// and re-baselines. Without this the smoothing consumes the whole
		// distance at once — which is the teleport it exists to prevent, and it
		// is what this did until the test said otherwise.
		expect(interp.advance(31_000)).toEqual([]);

		// The NEXT real frame then eases normally from where it actually was.
		const [step] = interp.advance(31_016);
		expect(step?.at.x).toBeGreaterThan(0);
		expect(step?.at.x).toBeLessThan(100);
	});

	it('starts a new track AT its target rather than easing in from nowhere', () => {
		const interp = new Interpolator();
		interp.towards('a', { x: 500, y: 500 });
		interp.advance(1000);
		const [step] = interp.advance(1016);
		expect(step?.at).toEqual({ x: 500, y: 500 });
	});

	it('eases toward a new target over several frames', () => {
		const interp = new Interpolator();
		interp.towards('a', { x: 0, y: 0 });
		interp.advance(1000);
		interp.towards('a', { x: 100, y: 0 });

		const xs = run(interp, 6, 1000).map((at) => at.x);
		expect(xs).toHaveLength(6);
		// Monotonic, and none of them is the destination — that IS the smoothing.
		expect(xs).toEqual([...xs].sort((a, b) => a - b));
		expect(new Set(xs).size).toBe(xs.length);
		const last = xs.at(-1) ?? 0;
		expect(last).toBeLessThan(100);
		// ...but well on its way after roughly one time constant.
		expect(last).toBeGreaterThan(50);
	});

	it('tracks several peers at once, independently', () => {
		const interp = new Interpolator();
		interp.towards('a', { x: 0, y: 0 });
		interp.towards('b', { x: 0, y: 0 });
		interp.advance(1000);
		interp.towards('a', { x: 100, y: 0 });
		const steps = interp.advance(1016);
		expect(steps).toHaveLength(2);
		expect(steps.find((step) => step.id === 'a')?.at.x).toBeGreaterThan(0);
		// b was never re-aimed, so it has not moved.
		expect(steps.find((step) => step.id === 'b')?.at.x).toBe(0);
	});

	describe('a drag that ends', () => {
		/**
		 * The rule that makes interpolation worth having: `drag_end` must not
		 * drop the overlay while the render is still behind, or the smoothing
		 * just relocates the jump to the end of the gesture.
		 */
		it('keeps animating after `end`, then reports done exactly once', () => {
			const interp = new Interpolator();
			interp.towards('a', { x: 0, y: 0 });
			interp.advance(1000);
			interp.towards('a', { x: 100, y: 0 });
			interp.advance(1016);

			expect(interp.end('a')).toBe(true);
			expect(interp.size).toBe(1);

			let now = 1016;
			let done: boolean | null = null;
			let frames = 0;
			while (done === null && frames < 500) {
				now += 16;
				frames += 1;
				for (const step of interp.advance(now)) if (step.done) done = true;
			}
			expect(done).toBe(true);
			// It lands exactly on the target, not epsilon short of it.
			expect(interp.size).toBe(0);
		});

		it('ends immediately when it has already arrived', () => {
			const interp = new Interpolator();
			interp.towards('a', { x: 10, y: 10 });
			expect(interp.end('a')).toBe(false);
			expect(interp.size).toBe(0);
		});

		it('ignores an end for something it never tracked', () => {
			expect(new Interpolator().end('ghost')).toBe(false);
		});

		it('comes back to life if another delta arrives', () => {
			const interp = new Interpolator();
			interp.towards('a', { x: 0, y: 0 });
			interp.advance(1000);
			interp.towards('a', { x: 100, y: 0 });
			interp.end('a');
			// They picked the drag back up before it finished settling.
			interp.towards('a', { x: 200, y: 0 });
			const steps = interp.advance(1016);
			expect(steps[0]?.done).toBe(false);
			expect(interp.size).toBe(1);
		});
	});

	it('forgets a track on demand, e.g. when the local user grabs it', () => {
		const interp = new Interpolator();
		interp.towards('a', { x: 0, y: 0 });
		interp.forget('a');
		expect(interp.size).toBe(0);
	});

	it('uses a catch-up constant longer than the 20Hz send interval', () => {
		// Smoothing has to span the gap BETWEEN deltas; a constant shorter than
		// the interval would finish before the next one arrives and step again.
		expect(CATCH_UP_MS).toBeGreaterThan(50);
	});
});

describe('smoothPoint', () => {
	it('smooths both axes', () => {
		const next = smoothPoint({ x: 0, y: 0 }, { x: 100, y: -100 }, 16);
		expect(next.x).toBeGreaterThan(0);
		expect(next.y).toBeLessThan(0);
	});
});
