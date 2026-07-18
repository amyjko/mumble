import type { Transform } from '$lib/model/types';

/**
 * Pure resize/rotate transform math (UX-OBJ-1), node-tested. Both feed
 * move_object, so the store's overlap solver validates the result — these just
 * compute the desired transform from a handle drag. Deltas are in world
 * coordinates. Resize operates on world axes and ignores rotation (a
 * prototype-acceptable approximation; true rotated-handle resize is deferred
 * with rotated-shape collision — see the note in ObjectFrame).
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
export interface Size {
	width: number;
	height: number;
}

export function minSizeFor(type: 'note' | 'timer' | 'chat' | 'drawing'): Size {
	switch (type) {
		case 'timer':
			return { width: 190, height: 170 };
		case 'chat':
			return { width: 200, height: 140 };
		case 'note':
			return { width: 140, height: 80 };
		case 'drawing':
			return { width: MIN_SIZE, height: MIN_SIZE };
	}
}

/**
 * Grid increment for Shift-snapping, matching the keyboard's coarse arrow step
 * so pointer and keyboard land on the same lattice.
 *
 * Shift means different things on the two input paths, deliberately: for a
 * POINTER gesture it snaps to this grid, while for keyboard arrows it means
 * the FINE 1px step. Each is unambiguous in its own context — there is no
 * "fine" notion while dragging, and no need for snapping when every arrow
 * press is already a fixed increment.
 */
export const SNAP_GRID = 16;

export function snapTo(value: number, snap: boolean): number {
	return snap ? Math.round(value / SNAP_GRID) * SNAP_GRID : value;
}

export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

export function resizeTransform(
	start: Transform,
	handle: ResizeHandle,
	dx: number,
	dy: number,
	snap = false,
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
		width = Math.max(min.width, snapTo(start.width + dx, snap));
		height = Math.max(min.height, snapTo(start.height + dy, snap));
	} else if (handle === 'sw') {
		width = Math.max(min.width, snapTo(start.width - dx, snap));
		height = Math.max(min.height, snapTo(start.height + dy, snap));
		x = right - width;
	} else if (handle === 'ne') {
		width = Math.max(min.width, snapTo(start.width + dx, snap));
		height = Math.max(min.height, snapTo(start.height - dy, snap));
		y = bottom - height;
	} else {
		// nw
		width = Math.max(min.width, snapTo(start.width - dx, snap));
		height = Math.max(min.height, snapTo(start.height - dy, snap));
		x = right - width;
		y = bottom - height;
	}
	return { ...start, x, y, width, height };
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
export function snapRotation(deg: number, snap: boolean): number {
	const wrapped = ((deg % 360) + 360) % 360;
	return snap ? Math.round(wrapped / 15) * 15 : wrapped;
}
