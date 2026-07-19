import type { Point, Size, Transform } from '$lib/model/types';
import type { Viewport } from './viewport.svelte';
import { hint, SNAP_HINT } from './hint.svelte';
import {
	centerOf,
	resizeTransform,
	rotationForPointer,
	snapRotation,
	snapTo,
	type ResizeHandle
} from './resize';
import { createThrottle } from './ephemeral.svelte';

/**
 * The two canvas gestures — drag, and transform-by-handle — implemented once.
 *
 * ObjectFrame, AvatarTile, and PlacerMarker each had their own copy. The
 * copies were near-identical, and near-identical is the expensive kind: every
 * correction had to be applied three times, and the third was repeatedly
 * missed. What that actually cost, all of it found by auditing rather than by
 * anyone reporting it:
 *
 *  - Placers rotated about their TOP-LEFT corner, because two copies converted
 *    the transform to a centre and the third passed it through.
 *  - Placer rotation was never wrapped or quantised, so pressing `]` enough
 *    times stored 375° — and a placer's rotation is ADOPTED by whoever arrives
 *    in it, so the bad value flowed into participant state.
 *  - Avatars and placers never snapped to the grid, because when snapping
 *    became the default only the object copy called `snapTo`.
 *
 * Each of those is one line in one copy. Together they are an argument for
 * this module: the rules now live where they cannot be partially applied.
 *
 * `.svelte.ts` because the returned `dragging` flag is `$state` — components
 * bind it to a cursor.
 */

export interface DragGesture {
	readonly dragging: boolean;
	onPointerDown: (event: PointerEvent) => void;
	onPointerMove: (event: PointerEvent) => void;
	onPointerUp: () => void;
}

export interface DragOptions {
	/**
	 * A GETTER, not the instance: `viewport` reaches these components as a
	 * prop, and capturing a prop's initial value is how a component silently
	 * keeps talking to a stale object after a rebind (Svelte warns about
	 * exactly this).
	 */
	viewport: () => Viewport;
	/** Where the thing is now, in world coordinates. */
	origin: () => Point;
	/** False disables the gesture entirely (an uneditable object). */
	enabled?: () => boolean;
	/**
	 * Constrain a desired position — the overlap solver, or identity for things
	 * that hold no space. Receives the last resolved position so a solver can
	 * slide along a contact rather than teleport.
	 */
	resolve?: (desired: Point, from: Point) => Point;
	/** Called on every move with the resolved position (throttled separately). */
	preview: (at: Point) => void;
	/** Called at most ~20 Hz (AR-BACKEND-5), for peer broadcast. */
	broadcast?: (at: Point) => void;
	commit: (at: Point) => void;
}

/**
 * Drag with pointer capture, grid snapping, and throttled broadcast.
 *
 * Snapping happens HERE rather than at each call site, which is the property
 * that would have prevented the regression above: a new draggable inherits the
 * grid instead of having to remember it.
 */
export function createDragGesture(options: DragOptions): DragGesture {
	const { viewport, origin, enabled, resolve, preview, broadcast, commit } = options;
	const throttle = createThrottle();

	let dragging = $state(false);
	let pointerStart: Point = { x: 0, y: 0 };
	let start: Point = { x: 0, y: 0 };
	let lastResolved: Point = { x: 0, y: 0 };

	return {
		get dragging() {
			return dragging;
		},
		onPointerDown(event: PointerEvent): void {
			if (enabled !== undefined && !enabled()) return;
			event.stopPropagation();
			dragging = true;
			pointerStart = viewport().toWorld({ x: event.clientX, y: event.clientY });
			start = { ...origin() };
			lastResolved = start;
			hint.show(SNAP_HINT);
			if (event.currentTarget instanceof HTMLElement) {
				event.currentTarget.setPointerCapture(event.pointerId);
			}
		},
		onPointerMove(event: PointerEvent): void {
			if (!dragging) return;
			const world = viewport().toWorld({ x: event.clientX, y: event.clientY });
			const modifiers = { precise: event.shiftKey };
			const desired = {
				x: snapTo(start.x + (world.x - pointerStart.x), modifiers),
				y: snapTo(start.y + (world.y - pointerStart.y), modifiers)
			};
			lastResolved = resolve === undefined ? desired : resolve(desired, lastResolved);
			preview(lastResolved);
			if (broadcast !== undefined && throttle.shouldSend(performance.now())) {
				broadcast(lastResolved);
			}
		},
		onPointerUp(): void {
			if (!dragging) return;
			dragging = false;
			hint.clear();
			commit(lastResolved);
		}
	};
}

export interface HandleGesture {
	onHandleDown: (kind: ResizeHandle | 'rotate', event: PointerEvent) => void;
}

export interface HandleOptions {
	/** A getter, for the reason given on DragOptions. */
	viewport: () => Viewport;
	/** The transform at the moment the handle is pressed. */
	start: () => Transform;
	/** Smallest permitted size — per object type, or a per-entity floor. */
	min: () => Size;
	preview: (next: Transform) => void;
	commit: (next: Transform) => void;
}

/**
 * Resize and rotate from a corner grip or the rotate grip.
 *
 * Rotation pivots about `centerOf(start)`. That conversion is the one this
 * module exists to make unforgettable: `rotationForPointer` takes a centre and
 * a transform carries a top-left, and one of the three copies passed the
 * transform straight through.
 */
export function createHandleGesture(options: HandleOptions): HandleGesture {
	const { viewport, start, min, preview, commit } = options;

	let kind: ResizeHandle | 'rotate' | null = null;
	let from: Transform = { x: 0, y: 0, width: 0, height: 0, rotation: 0, z: 0 };
	let last: Transform = from;
	let pointer: Point = { x: 0, y: 0 };

	function onMove(event: PointerEvent): void {
		if (kind === null) return;
		const world = viewport().toWorld({ x: event.clientX, y: event.clientY });
		const modifiers = { precise: event.shiftKey };
		last =
			kind === 'rotate'
				? { ...from, rotation: snapRotation(rotationForPointer(centerOf(from), world), modifiers) }
				: resizeTransform(from, kind, world.x - pointer.x, world.y - pointer.y, modifiers, min());
		preview(last);
	}

	function onUp(): void {
		window.removeEventListener('pointermove', onMove);
		hint.clear();
		if (kind === null) return;
		kind = null;
		commit(last);
	}

	return {
		onHandleDown(handle: ResizeHandle | 'rotate', event: PointerEvent): void {
			event.stopPropagation();
			kind = handle;
			from = start();
			last = from;
			pointer = viewport().toWorld({ x: event.clientX, y: event.clientY });
			hint.show(SNAP_HINT);
			// On `window`, not the grip: the pointer routinely leaves a 12px
			// handle mid-gesture, and a listener on the grip would drop the drag.
			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', onUp, { once: true });
		}
	};
}

/**
 * Keyboard transform vocabulary, shared so the three components cannot drift
 * apart — they already had: `Shift+C` reshaped an object and an avatar but not
 * a placer, and Alt+Arrow resized by 16px in two of them and 1px in the third.
 *
 * These take the two fields they READ rather than a `KeyboardEvent`, which
 * keeps them pure and node-testable (AR-TEST-4) instead of dragging in a DOM
 * type the logic has no use for. A real event satisfies the shape.
 */
export interface KeyPress {
	key: string;
	shiftKey: boolean;
}

/** Arrow-key movement delta, or null for any other key. Shift is fine placement. */
export function arrowDelta(event: KeyPress): Point | null {
	const step = event.shiftKey ? 1 : 16;
	switch (event.key) {
		case 'ArrowLeft':
			return { x: -step, y: 0 };
		case 'ArrowRight':
			return { x: step, y: 0 };
		case 'ArrowUp':
			return { x: 0, y: -step };
		case 'ArrowDown':
			return { x: 0, y: step };
		default:
			return null;
	}
}

/** Alt+Arrow resize, clamped to `min`. Null for any other key. */
export function resizeByKey(size: Size, event: KeyPress, min: Size): Size | null {
	// A fixed step, NOT the arrow step: Shift means "precise" for movement, but
	// a 1px resize is indistinguishable from noise, and one copy shipped it.
	const step = 16;
	switch (event.key) {
		case 'ArrowRight':
			return { ...size, width: size.width + step };
		case 'ArrowLeft':
			return { ...size, width: Math.max(min.width, size.width - step) };
		case 'ArrowDown':
			return { ...size, height: size.height + step };
		case 'ArrowUp':
			return { ...size, height: Math.max(min.height, size.height - step) };
		default:
			return null;
	}
}

/**
 * `[` / `]` rotation, quantised and wrapped into [0, 360). Null for other keys.
 *
 * Wrapping matters beyond tidiness: a placer's rotation is adopted by whoever
 * arrives in it, so an unwrapped 375° became a participant's rotation.
 */
export function rotateByKey(rotation: number, event: KeyPress): number | null {
	if (event.key !== '[' && event.key !== ']') return null;
	return snapRotation(rotation + (event.key === ']' ? 15 : -15), { precise: false });
}

/** True for the reshape key, in either case — one copy accepted only lowercase. */
export function isReshapeKey(event: KeyPress): boolean {
	return event.key === 'c' || event.key === 'C';
}
