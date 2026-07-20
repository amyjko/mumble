import type { Point, Size, Transform } from '$lib/model/types';

/**
 * Pure resize/rotate transform math (UX-OBJ-1), node-tested. Both feed
 * move_object, so the store's overlap solver validates the result — these just
 * compute the desired transform from a handle drag. Deltas are in world
 * coordinates. Resize operates on world axes and ignores rotation. That is a
 * DECISION, not a gap (ratified 2026-07-18): rotated-shape collision is exact
 * (SAT/OBB, see geometry.ts), and only the drag-to-resize feel is approximate,
 * which has not bothered anyone in use. Do not "fix" it without a report.
 */

export const MIN_SIZE = 40;

/**
 * Minimum size per object TYPE. A flat floor of 40px was nonsense for objects
 * that carry controls: the content area is inset by the sticker border, and
 * `.content` clips overflow — so a 40px timer hid its own start/reset buttons
 * behind the clip and became unusable with no way to grow it back by pointer.
 *
 * The numbers are what each type needs to stay operable:
 *  - note:    ~2 lines x ~14 characters of body text
 *  - timer:   readout + the mode switch + the adjust row
 *  - chat:    a couple of log lines + the compose row
 *  - drawing: no controls at all, so the flat floor is fine
 */
export function minSizeFor(
	type: 'note' | 'timer' | 'chat' | 'drawing' | 'screenshare'
): Size {
	switch (type) {
		case 'timer':
			return { width: 190, height: 170 };
		case 'chat':
			return { width: 200, height: 140 };
		case 'note':
			return { width: 140, height: 80 };
		case 'drawing':
			return { width: MIN_SIZE, height: MIN_SIZE };
		case 'screenshare':
			// Larger than anything else, and 16:9. A share shrunk below this is
			// unreadable, and the ladder picks its rung from the rendered width —
			// so a tiny share would also quietly request a tiny encode.
			return { width: 320, height: 180 };
	}
}

/**
 * Grid increment, matching the keyboard's coarse arrow step so pointer and
 * keyboard land on the same lattice.
 */
export const SNAP_GRID = 16;

/**
 * Gesture modifiers. An OBJECT rather than a bare boolean on purpose: snapping
 * used to be opt-in via Shift and is now the default, and flipping a boolean
 * at each call site would have compiled cleanly whether or not I found them
 * all — a missed one silently keeps the old behaviour in one gesture. Changing
 * the shape makes the compiler enumerate the call sites.
 */
export interface Modifiers {
	/** Shift: step out of the grid for fine placement. */
	precise: boolean;
}

/**
 * Snap to the grid UNLESS precision is requested (Shift).
 *
 * Snapping is the default because alignment is what people want almost always,
 * and shift-to-snap put the effort on the common case while leaving un-aligned
 * layouts as the thing you got by not knowing about a modifier. Shift now
 * means the same thing on both input paths — "smaller, more exact" — where it
 * used to mean snap for the pointer and fine-step for the keyboard.
 */
export function snapTo(value: number, { precise }: Modifiers): number {
	return precise ? value : Math.round(value / SNAP_GRID) * SNAP_GRID;
}

export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

export function resizeTransform(
	start: Transform,
	handle: ResizeHandle,
	dx: number,
	dy: number,
	modifiers: Modifiers,
	min: Size = { width: MIN_SIZE, height: MIN_SIZE }
): Transform {
	let x = start.x;
	let y = start.y;
	let width: number;
	let height: number;
	const right = start.x + start.width;
	const bottom = start.y + start.height;

	// Snap the SIZE, then derive the moving edge from it, so the anchored
	// corner stays exactly put — snapping x/y afterwards would drift it.
	if (handle === 'se') {
		width = Math.max(min.width, snapTo(start.width + dx, modifiers));
		height = Math.max(min.height, snapTo(start.height + dy, modifiers));
	} else if (handle === 'sw') {
		width = Math.max(min.width, snapTo(start.width - dx, modifiers));
		height = Math.max(min.height, snapTo(start.height + dy, modifiers));
		x = right - width;
	} else if (handle === 'ne') {
		width = Math.max(min.width, snapTo(start.width + dx, modifiers));
		height = Math.max(min.height, snapTo(start.height - dy, modifiers));
		y = bottom - height;
	} else {
		// nw
		width = Math.max(min.width, snapTo(start.width - dx, modifiers));
		height = Math.max(min.height, snapTo(start.height - dy, modifiers));
		x = right - width;
		y = bottom - height;
	}
	return { ...start, x, y, width, height };
}

/**
 * The centre of a transform, which is what rotation pivots about.
 *
 * Exists because `rotationForPointer` takes a CENTRE and a transform carries a
 * TOP-LEFT, so every caller had to remember to convert. Two of the three
 * remembered; the third passed the transform straight through and rotated
 * about its corner. Naming the conversion is what stops the fourth caller
 * getting it wrong.
 */
export function centerOf(t: { x: number; y: number; width: number; height: number }): Point {
	return { x: t.x + t.width / 2, y: t.y + t.height / 2 };
}

/** Rotation (degrees) so the object's top points toward the pointer. */
export function rotationForPointer(
	center: { x: number; y: number },
	pointer: { x: number; y: number }
): number {
	const angle = (Math.atan2(pointer.y - center.y, pointer.x - center.x) * 180) / Math.PI;
	// The rotate handle sits above the object (−90° from the +x axis).
	return Math.round(angle + 90);
}

/** Snap rotation to 15° increments when a modifier requests it. */
export function snapRotation(deg: number, { precise }: Modifiers): number {
	const wrapped = ((deg % 360) + 360) % 360;
	return precise ? wrapped : Math.round(wrapped / 15) * 15;
}
