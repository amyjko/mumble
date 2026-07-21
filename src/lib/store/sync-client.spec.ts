import { describe, expect, it } from 'vitest';
import { SyncClient, type Frames, type SyncBackend } from './sync-client.svelte';
import type { EphemeralMessage } from '$lib/model/types';

/**
 * The receive half of AR-BACKEND-5: a peer's throttled drag, smoothed.
 *
 * The send half was always right — one 20Hz throttle shared by every draggable
 * — but the receiver wrote each arriving delta straight into the overlay, so a
 * peer's drag rendered as twenty jumps a second. This covers the wiring:
 * `interpolate.spec.ts` covers the arithmetic.
 *
 * Frames are INJECTED rather than waited for. `requestAnimationFrame` does not
 * exist in the node project, and a test that waits real frames measures the
 * harness rather than the code.
 */

/** A hand-cranked frame clock. */
function fakeFrames(): Frames & { step: (now: number) => void; pending: boolean } {
	let queued: ((now: number) => void) | null = null;
	return {
		request(callback) {
			queued = callback;
			return 1;
		},
		cancel() {
			queued = null;
		},
		get pending() {
			return queued !== null;
		},
		step(now) {
			const run = queued;
			queued = null;
			run?.(now);
		}
	};
}

/**
 * A store double.
 *
 * `SyncBackend` is the three methods SyncClient actually uses, so this is a
 * complete implementation of its dependency rather than a partial one wearing a
 * cast — which is not available here anyway, since type assertions are banned.
 */
function fakeStore(): {
	store: SyncBackend;
	emit: (message: EphemeralMessage) => void;
	sent: EphemeralMessage[];
} {
	let handler: ((message: EphemeralMessage) => void) | null = null;
	const sent: EphemeralMessage[] = [];
	return {
		store: {
			onEphemeral(next) {
				handler = next;
				return () => {
					handler = null;
				};
			},
			sendEphemeral(message) {
				sent.push(message);
			},
			commit() {
				return Promise.resolve();
			}
		},
		emit(message) {
			handler?.(message);
		},
		sent
	};
}

const transform = (x: number, y: number) => ({ x, y, width: 100, height: 80, rotation: 0, z: 1 });

describe('a peer drag is smoothed rather than snapped', () => {
	it('shows the first delta immediately, so nothing appears late', () => {
		const frames = fakeFrames();
		const { store, emit } = fakeStore();
		const sync = new SyncClient(store, frames, true);

		emit({ kind: 'drag_object', id: 'obj', transform: transform(500, 500) });
		expect(sync.objectOverlays.get('obj')).toEqual(transform(500, 500));
	});

	it('eases toward a later delta instead of jumping to it', () => {
		const frames = fakeFrames();
		const { store, emit } = fakeStore();
		const sync = new SyncClient(store, frames, true);

		emit({ kind: 'drag_object', id: 'obj', transform: transform(0, 0) });
		frames.step(1000);
		emit({ kind: 'drag_object', id: 'obj', transform: transform(200, 0) });
		frames.step(1016);

		const at = sync.objectOverlays.get('obj');
		// The whole claim: strictly between where it was and where it is going.
		expect(at?.x).toBeGreaterThan(0);
		expect(at?.x).toBeLessThan(200);
	});

	it('carries size and rotation through untouched, smoothing only position', () => {
		const frames = fakeFrames();
		const { store, emit } = fakeStore();
		const sync = new SyncClient(store, frames, true);

		emit({ kind: 'drag_object', id: 'obj', transform: { ...transform(0, 0), rotation: 30, z: 7 } });
		frames.step(1000);
		emit({ kind: 'drag_object', id: 'obj', transform: { ...transform(200, 0), rotation: 30, z: 7 } });
		frames.step(1016);

		const at = sync.objectOverlays.get('obj');
		expect(at?.rotation).toBe(30);
		expect(at?.z).toBe(7);
		expect(at?.width).toBe(100);
	});

	it('smooths participant drags the same way', () => {
		const frames = fakeFrames();
		const { store, emit } = fakeStore();
		const sync = new SyncClient(store, frames, true);

		emit({ kind: 'drag_participant', id: 'pal', location: { x: 0, y: 0 } });
		frames.step(1000);
		emit({ kind: 'drag_participant', id: 'pal', location: { x: 200, y: 0 } });
		frames.step(1016);

		const at = sync.participantOverlays.get('pal');
		expect(at?.x).toBeGreaterThan(0);
		expect(at?.x).toBeLessThan(200);
	});

	/**
	 * The rule that makes smoothing worth having. Clearing the overlay the
	 * moment a peer drops would snap the object from wherever the animation had
	 * reached to its settled transform — one big jump instead of twenty small
	 * ones, which is a worse artefact than the problem.
	 */
	it('keeps the overlay after drag_end until it has caught up', () => {
		const frames = fakeFrames();
		const { store, emit } = fakeStore();
		const sync = new SyncClient(store, frames, true);

		emit({ kind: 'drag_object', id: 'obj', transform: transform(0, 0) });
		frames.step(1000);
		emit({ kind: 'drag_object', id: 'obj', transform: transform(500, 0) });
		frames.step(1016);
		emit({ kind: 'drag_end', id: 'obj' });

		// Still there, still moving.
		expect(sync.objectOverlays.has('obj')).toBe(true);

		let now = 1016;
		for (let i = 0; i < 400 && sync.objectOverlays.has('obj'); i += 1) {
			now += 16;
			frames.step(now);
		}
		// ...and eventually hands back to the settled state.
		expect(sync.objectOverlays.has('obj')).toBe(false);
	});

	it('drops the overlay at once when the drag ended where it already was', () => {
		const frames = fakeFrames();
		const { store, emit } = fakeStore();
		const sync = new SyncClient(store, frames, true);

		emit({ kind: 'drag_object', id: 'obj', transform: transform(10, 10) });
		emit({ kind: 'drag_end', id: 'obj' });
		expect(sync.objectOverlays.has('obj')).toBe(false);
	});

	it('stops smoothing an object once WE start dragging it', () => {
		const frames = fakeFrames();
		const { store, emit } = fakeStore();
		const sync = new SyncClient(store, frames, true);

		emit({ kind: 'drag_object', id: 'obj', transform: transform(0, 0) });
		frames.step(1000);
		emit({ kind: 'drag_object', id: 'obj', transform: transform(500, 0) });

		sync.takeOver('obj');
		sync.objectOverlays.set('obj', transform(42, 42));
		frames.step(1016);

		// Our value survives: the peer's track no longer writes here.
		expect(sync.objectOverlays.get('obj')).toEqual(transform(42, 42));
	});
});

describe('prefers-reduced-motion (UX-A11Y-4)', () => {
	/**
	 * Smoothing is presentation, not content — the movement itself still
	 * happens, it simply stops being animated. With it off the behaviour is
	 * exactly what it was before this feature existed.
	 */
	it('applies deltas directly and schedules no frames', () => {
		const frames = fakeFrames();
		const { store, emit } = fakeStore();
		const sync = new SyncClient(store, frames, false);

		emit({ kind: 'drag_object', id: 'obj', transform: transform(0, 0) });
		emit({ kind: 'drag_object', id: 'obj', transform: transform(200, 0) });

		expect(sync.objectOverlays.get('obj')).toEqual(transform(200, 0));
		expect(frames.pending).toBe(false);
	});

	it('clears the overlay immediately on drag_end', () => {
		const frames = fakeFrames();
		const { store, emit } = fakeStore();
		const sync = new SyncClient(store, frames, false);

		emit({ kind: 'drag_object', id: 'obj', transform: transform(0, 0) });
		emit({ kind: 'drag_end', id: 'obj' });
		expect(sync.objectOverlays.has('obj')).toBe(false);
	});
});
