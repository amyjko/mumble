/**
 * Drag-broadcast throttling (AR-BACKEND-5).
 *
 * The requirement is "~15–20 Hz with client-side interpolation", chosen for
 * perceived smoothness AND to stay inside Realtime message quotas — so the
 * rate is a cost decision, not a feel preference, and a copy that drifts up
 * costs money on a plane nobody is watching.
 *
 * It was a bare `50` written out twice, in ObjectFrame and AvatarTile, with
 * nothing tying either to the requirement. Naming it once means a future third
 * draggable inherits the rate instead of inventing one, which is exactly what
 * PlacerMarker did — it broadcasts nothing at all.
 */

/** 50ms = 20 Hz, the top of AR-BACKEND-5's range. */
export const EPHEMERAL_INTERVAL_MS = 50;

/**
 * A rate limiter for one gesture. Stateful by design: a drag is a stream and
 * the limiter has to remember when it last let something through.
 *
 * `now` is a parameter rather than read inside, so this stays testable without
 * faking the clock — the same reason timer.ts takes its own `now`.
 */
export function createThrottle(intervalMs: number = EPHEMERAL_INTERVAL_MS): {
	shouldSend: (now: number) => boolean;
} {
	let lastAt = Number.NEGATIVE_INFINITY;
	return {
		shouldSend(now: number): boolean {
			if (now - lastAt < intervalMs) return false;
			lastAt = now;
			return true;
		}
	};
}
