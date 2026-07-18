import type { TimerPayload } from './types';

/**
 * Pure timer math (UX-OBJ-4), node-tested and shared by the component and any
 * caller. Elapsed is derived from the shared anchor (elapsedBeforeMs +
 * live run since startedAt), so every viewer computes the same value from the
 * same payload — `now` is passed in, never read here, to keep this pure.
 */
export function elapsedMs(payload: TimerPayload, now: number): number {
	const live = payload.running && payload.startedAt !== null ? now - payload.startedAt : 0;
	return payload.elapsedBeforeMs + Math.max(0, live);
}

/** What the timer shows: remaining for countdown (clamped ≥ 0), elapsed for countup. */
export function displayMs(payload: TimerPayload, now: number): number {
	const elapsed = elapsedMs(payload, now);
	return payload.mode === 'countdown' ? Math.max(0, payload.durationMs - elapsed) : elapsed;
}

/** A countdown that has reached zero (for a done state / no negative display). */
export function isFinished(payload: TimerPayload, now: number): boolean {
	return payload.mode === 'countdown' && elapsedMs(payload, now) >= payload.durationMs;
}

/** Start/resume from the current anchor. Idempotent if already running. */
export function started(payload: TimerPayload, now: number): TimerPayload {
	if (payload.running) return payload;
	return { ...payload, running: true, startedAt: now };
}

/** Pause: fold the live run into elapsedBeforeMs and drop the anchor. */
export function paused(payload: TimerPayload, now: number): TimerPayload {
	if (!payload.running) return payload;
	return {
		...payload,
		running: false,
		startedAt: null,
		elapsedBeforeMs: elapsedMs(payload, now)
	};
}

/** Reset to zero elapsed, stopped. */
export function reset(payload: TimerPayload): TimerPayload {
	return { ...payload, running: false, startedAt: null, elapsedBeforeMs: 0 };
}

/** mm:ss (or h:mm:ss past an hour) for display. */
export function formatMs(ms: number): string {
	const total = Math.round(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number): string => n.toString().padStart(2, '0');
	return h > 0 ? `${h.toString()}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
