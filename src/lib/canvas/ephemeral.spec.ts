import { describe, expect, it } from 'vitest';
import { EPHEMERAL_INTERVAL_MS, createThrottle } from './ephemeral.svelte';

describe('drag broadcast throttling (AR-BACKEND-5)', () => {
	it('stays within the requirement\'s 15-20 Hz band', () => {
		// The rate is a QUOTA decision, not a feel preference — this is the
		// assertion that makes the requirement enforceable rather than quoted.
		const hz = 1000 / EPHEMERAL_INTERVAL_MS;
		expect(hz).toBeGreaterThanOrEqual(15);
		expect(hz).toBeLessThanOrEqual(20);
	});

	it('lets the first event through, then rate-limits', () => {
		const throttle = createThrottle(50);
		// The first move of a drag must not be swallowed, or a peer sees
		// nothing for the first 50ms of every gesture.
		expect(throttle.shouldSend(1000)).toBe(true);
		expect(throttle.shouldSend(1020)).toBe(false);
		expect(throttle.shouldSend(1049)).toBe(false);
		expect(throttle.shouldSend(1050)).toBe(true);
	});

	it('measures from the last SENT event, not the last attempt', () => {
		// A limiter that restarts its window on every call starves the stream:
		// a drag emitting every 20ms would never send a second time.
		const throttle = createThrottle(50);
		expect(throttle.shouldSend(0)).toBe(true);
		for (const t of [20, 40]) expect(throttle.shouldSend(t)).toBe(false);
		expect(throttle.shouldSend(60)).toBe(true);
	});

	it('gives each gesture its own budget', () => {
		const a = createThrottle(50);
		const b = createThrottle(50);
		expect(a.shouldSend(0)).toBe(true);
		// Dragging a second thing must not be muted by the first's window.
		expect(b.shouldSend(0)).toBe(true);
	});
});
