import type { Point } from '$lib/model/types';

/**
 * Client-side interpolation for peers' in-flight drags (AR-BACKEND-5).
 *
 * The requirement is "~15–20 Hz with client-side interpolation", and only the
 * first half existed: `ephemeral.svelte.ts` throttles the SEND to 20 Hz, and
 * the receiver wrote every arriving delta straight into the overlay. So a
 * peer's drag rendered as twenty discrete jumps a second — correct, and visibly
 * mechanical next to your own drag, which follows the pointer.
 *
 * The throttle is a COST decision (Realtime quotas), not a feel one, which is
 * exactly why interpolation is the required other half: it buys smoothness
 * without buying messages. Raising the rate instead would look the same and
 * bill differently, on a plane nobody is watching.
 *
 * Pure and node-tested per AR-TEST-4, which names this class of logic
 * specifically: coordinate arithmetic must stay extractable from the components
 * that render it. `now` is a parameter rather than read inside — the same
 * convention as `createThrottle` and `timer.ts` — so tests need no fake clock.
 */

/**
 * How fast a tracked point catches up, as an exponential time constant.
 *
 * ~90ms sits deliberately just above the 50ms send interval: below it, motion
 * still steps between packets; far above it, a peer's object visibly lags the
 * person dragging it. This smooths ACROSS the gap between two deltas rather
 * than hiding it.
 */
export const CATCH_UP_MS = 90;

/**
 * Close enough to stop animating, in world units. Sub-pixel at any sane zoom,
 * so arriving is invisible — it exists to end the loop, not to snap.
 */
export const ARRIVED_EPSILON = 0.05;

/**
 * A gap longer than this is not a frame — it is the clock restarting.
 *
 * `requestAnimationFrame` stops in a backgrounded tab, so returning to one
 * produces a gap of seconds. Feeding that to the smoothing would consume the
 * whole remaining distance in one step and teleport every tracked object, which
 * is the precise jump this module exists to prevent. ~100ms is comfortably
 * above a slow frame (a 30Hz stutter is 33ms) and far below any real idle.
 */
export const MAX_FRAME_MS = 100;

/**
 * Move `current` toward `target` by one frame of exponential smoothing.
 *
 * Frame-rate independent BY CONSTRUCTION: the factor is derived from elapsed
 * time, so two 8ms steps land where one 16ms step does. A naive `current +=
 * (target - current) * 0.2` per frame does not have that property — it makes
 * the animation's speed depend on the display's refresh rate, which is how the
 * same code feels different on a 120Hz laptop and a loaded one.
 *
 * Never overshoots: the factor is in [0, 1), so the result stays strictly
 * between `current` and `target`.
 */
export function smoothStep(current: number, target: number, dtMs: number, tauMs = CATCH_UP_MS): number {
	if (dtMs <= 0) return current;
	if (tauMs <= 0) return target;
	const factor = 1 - Math.exp(-dtMs / tauMs);
	return current + (target - current) * factor;
}

export function smoothPoint(current: Point, target: Point, dtMs: number, tauMs = CATCH_UP_MS): Point {
	return {
		x: smoothStep(current.x, target.x, dtMs, tauMs),
		y: smoothStep(current.y, target.y, dtMs, tauMs)
	};
}

export function hasArrived(current: Point, target: Point, epsilon = ARRIVED_EPSILON): boolean {
	return Math.abs(current.x - target.x) <= epsilon && Math.abs(current.y - target.y) <= epsilon;
}

/** One thing being smoothed toward wherever its owner last said it was. */
interface Track {
	current: Point;
	target: Point;
	/** Their drag ended; finish the motion, then let the settled state take over. */
	ended: boolean;
}

/** What `advance` reports for one track this frame. */
export interface Advance {
	id: string;
	at: Point;
	/**
	 * The track is finished and has been dropped. True only for a track whose
	 * drag ENDED and has since caught up — a live drag never "arrives", because
	 * its owner may move again at any moment.
	 */
	done: boolean;
}

/**
 * Every peer drag currently being smoothed, advanced together.
 *
 * A class rather than free functions because a drag is a stream and something
 * has to remember where each one had got to — the same reason `createThrottle`
 * is stateful.
 */
export class Interpolator {
	private readonly tracks = new Map<string, Track>();
	private lastAt: number | null = null;

	get size(): number {
		return this.tracks.size;
	}

	/**
	 * A delta arrived: aim here.
	 *
	 * A brand-new track starts AT its target rather than easing in from
	 * nowhere. There is no previous position to ease from — the alternative is
	 * an object sliding in from wherever it happened to be, which is worse than
	 * the jump it replaces.
	 */
	towards(id: string, target: Point): void {
		const existing = this.tracks.get(id);
		if (existing === undefined) {
			this.tracks.set(id, { current: { ...target }, target: { ...target }, ended: false });
			return;
		}
		existing.target = { ...target };
		// A fresh delta means they are dragging again, so a track that was
		// winding down is live once more.
		existing.ended = false;
	}

	/**
	 * Their drag ended.
	 *
	 * NOT a removal. The rendered position may still be catching up, and
	 * dropping the overlay here would snap the object to its settled transform —
	 * trading twenty small steps for one visible jump, which is the failure this
	 * whole module exists to avoid. The track finishes its motion and reports
	 * `done` when it arrives.
	 *
	 * Ending something never tracked is a no-op: `drag_end` can arrive for an
	 * object whose deltas were all throttled away.
	 */
	end(id: string): boolean {
		const track = this.tracks.get(id);
		if (track === undefined) return false;
		if (hasArrived(track.current, track.target)) {
			this.tracks.delete(id);
			return false;
		}
		track.ended = true;
		return true;
	}

	/** Forget a track outright, e.g. when the local user grabs the same object. */
	forget(id: string): void {
		this.tracks.delete(id);
		if (this.tracks.size === 0) this.lastAt = null;
	}

	clear(): void {
		this.tracks.clear();
		this.lastAt = null;
	}

	/**
	 * Step every track and report where each now is.
	 *
	 * The first call after idle establishes the clock and moves nothing: there
	 * is no honest `dt` for it, and inventing one would make the first frame's
	 * distance depend on how long the tab happened to be idle. A gap longer
	 * than `MAX_FRAME_MS` is treated the same way, which is what stops a
	 * backgrounded tab from teleporting every tracked object when it returns.
	 */
	advance(now: number): Advance[] {
		const previous = this.lastAt;
		this.lastAt = now;
		if (previous === null) return [];

		const dt = now - previous;
		// Not a frame — the clock restarted. Re-baseline and move nothing.
		if (dt > MAX_FRAME_MS) return [];
		const moved: Advance[] = [];
		for (const [id, track] of this.tracks) {
			track.current = smoothPoint(track.current, track.target, dt);
			if (track.ended && hasArrived(track.current, track.target)) {
				this.tracks.delete(id);
				moved.push({ id, at: { ...track.target }, done: true });
				continue;
			}
			moved.push({ id, at: { ...track.current }, done: false });
		}
		if (this.tracks.size === 0) this.lastAt = null;
		return moved;
	}
}
