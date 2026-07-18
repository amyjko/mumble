import { describe, expect, it } from 'vitest';
import { displayMs, elapsedMs, formatMs, isFinished, paused, reset, started } from './timer';
import type { TimerPayload } from './types';

const base: TimerPayload = {
	mode: 'countdown',
	durationMs: 5 * 60 * 1000,
	running: false,
	startedAt: null,
	elapsedBeforeMs: 0
};

describe('timer math (UX-OBJ-4) — shared anchor, same time for all viewers', () => {
	it('a paused timer reads the same at any now', () => {
		const p = { ...base, elapsedBeforeMs: 90_000 };
		expect(displayMs(p, 1_000_000)).toBe(displayMs(p, 9_999_999));
		expect(displayMs(p, 0)).toBe(5 * 60 * 1000 - 90_000);
	});

	it('a running timer derives elapsed from startedAt (no per-client drift)', () => {
		const p = started(base, 1000);
		// Two "viewers" at the same wall-clock get identical displays.
		expect(displayMs(p, 4000)).toBe(displayMs(p, 4000));
		expect(elapsedMs(p, 4000)).toBe(3000);
	});

	it('countdown clamps at zero, and reports finished', () => {
		const p = { ...started(base, 0), durationMs: 2000 };
		expect(displayMs(p, 5000)).toBe(0);
		expect(isFinished(p, 5000)).toBe(true);
		expect(isFinished(p, 1000)).toBe(false);
	});

	it('countup just grows', () => {
		const p = { ...started(base, 0), mode: 'countup' as const };
		expect(displayMs(p, 7000)).toBe(7000);
	});

	it('pause folds the live run into elapsedBeforeMs', () => {
		const running = started(base, 1000);
		const stopped = paused(running, 4000);
		expect(stopped.running).toBe(false);
		expect(stopped.startedAt).toBeNull();
		expect(stopped.elapsedBeforeMs).toBe(3000);
		// Frozen after pause.
		expect(displayMs(stopped, 999_999)).toBe(displayMs(stopped, 4000));
	});

	it('start is idempotent; reset zeroes', () => {
		const r = started(base, 1000);
		expect(started(r, 5000)).toBe(r); // already running, unchanged
		const z = reset({ ...r, elapsedBeforeMs: 12345 });
		expect(z.elapsedBeforeMs).toBe(0);
		expect(z.running).toBe(false);
	});

	it('formats mm:ss and h:mm:ss', () => {
		expect(formatMs(0)).toBe('00:00');
		expect(formatMs(65_000)).toBe('01:05');
		expect(formatMs(3_661_000)).toBe('1:01:01');
	});
});
