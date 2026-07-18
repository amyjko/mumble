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

export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

export function resizeTransform(start: Transform, handle: ResizeHandle, dx: number, dy: number): Transform {
	let x = start.x;
	let y = start.y;
	let width: number;
	let height: number;
	const right = start.x + start.width;
	const bottom = start.y + start.height;

	if (handle === 'se') {
		width = Math.max(MIN_SIZE, start.width + dx);
		height = Math.max(MIN_SIZE, start.height + dy);
	} else if (handle === 'sw') {
		width = Math.max(MIN_SIZE, start.width - dx);
		height = Math.max(MIN_SIZE, start.height + dy);
		x = right - width;
	} else if (handle === 'ne') {
		width = Math.max(MIN_SIZE, start.width + dx);
		height = Math.max(MIN_SIZE, start.height - dy);
		y = bottom - height;
	} else {
		// nw
		width = Math.max(MIN_SIZE, start.width - dx);
		height = Math.max(MIN_SIZE, start.height - dy);
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
