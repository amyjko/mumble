import type { CanvasObject, Point, ScreenshareCanvasObject } from './types';
import type { Bounds } from './drawing';
import { nowIso } from './types';
import { DEFAULT_BORDER_WIDTH } from './schemas';

/**
 * The one place notes are born — used by the canvas double-click AND the
 * header's "+ note" button (UX-A11Y-2: creation must not require a pointer).
 */
export function newNote(creatorId: string, center: Point, maxZ: number, border = DEFAULT_BORDER_WIDTH): CanvasObject {
	const now = nowIso();
	const transform = {
		x: center.x - 100,
		y: center.y - 80,
		width: 200,
		height: 160,
		rotation: 0,
		z: maxZ + 1
	};
	return {
		id: crypto.randomUUID(),
		type: 'note',
		creator_id: creatorId,
		permission: 'all',
		transform,
		clip: { shape: 'rounded', radius: 8 },
		border: { width: border },
		hidden: false,
		payload: { text: '', doc: '' },
		created_at: now,
		updated_at: now
	};
}

/** A paused 5-minute countdown by default — a sensible starting shape. */
export function newTimer(creatorId: string, center: Point, maxZ: number, border = DEFAULT_BORDER_WIDTH): CanvasObject {
	const now = nowIso();
	// 240x210, not 180x120: the old default was SMALLER than the timer's own
	// minimum (190x170), so every timer was born too small for its readout,
	// mode switch, and adjust row, and had to be resized before use.
	// create-sizes.spec.ts now fails if any default drops below its minimum.
	const transform = {
		x: center.x - 120,
		y: center.y - 105,
		width: 240,
		height: 210,
		rotation: 0,
		z: maxZ + 1
	};
	return {
		id: crypto.randomUUID(),
		type: 'timer',
		creator_id: creatorId,
		permission: 'all',
		transform,
		clip: { shape: 'rounded', radius: 8 },
		border: { width: border },
		hidden: false,
		payload: {
			mode: 'countdown',
			durationMs: 5 * 60 * 1000,
			running: false,
			startedAt: null,
			elapsedBeforeMs: 0
		},
		created_at: now,
		updated_at: now
	};
}

export function newChat(creatorId: string, center: Point, maxZ: number, border = DEFAULT_BORDER_WIDTH): CanvasObject {
	const now = nowIso();
	const transform = {
		x: center.x - 140,
		y: center.y - 110,
		width: 280,
		height: 220,
		rotation: 0,
		z: maxZ + 1
	};
	return {
		id: crypto.randomUUID(),
		type: 'chat',
		creator_id: creatorId,
		permission: 'all',
		transform,
		clip: { shape: 'rounded', radius: 8 },
		border: { width: border },
		hidden: false,
		payload: { messages: [] },
		created_at: now,
		updated_at: now
	};
}

/**
 * A screen share (UX-OBJ-6).
 *
 * 16:9 and large, because a share is read rather than glanced at — and the
 * ladder picks a rung from the rendered width, so a small default would quietly
 * request a rung too low to read the thing being shared.
 */
export function newScreenshare(
	ownerId: string,
	center: Point,
	maxZ: number,
	border = DEFAULT_BORDER_WIDTH
): ScreenshareCanvasObject {
	const now = nowIso();
	const transform = {
		x: center.x - 320,
		y: center.y - 180,
		width: 640,
		height: 360,
		rotation: 0,
		z: maxZ + 1
	};
	return {
		id: crypto.randomUUID(),
		type: 'screenshare',
		creator_id: ownerId,
		permission: 'all',
		transform,
		clip: { shape: 'rounded', radius: 8 },
		border: { width: border },
		hidden: false,
		// Equal to creator_id here, and deliberately a separate field: one is a
		// permission fact, the other is which peer's track feeds this tile.
		payload: { owner_id: ownerId },
		created_at: now,
		updated_at: now
	};
}

export function newDrawing(
	creatorId: string,
	box: Bounds,
	color: string,
	width: number,
	points: readonly Point[],
	maxZ: number
): CanvasObject {
	const now = nowIso();
	const transform = { x: box.x, y: box.y, width: box.width, height: box.height, rotation: 0, z: maxZ + 1 };
	return {
		id: crypto.randomUUID(),
		type: 'drawing',
		creator_id: creatorId,
		permission: 'all',
		transform,
		clip: { shape: 'rect' },
		border: { width: 0 },
		hidden: false,
		payload: { color, width, points: points.map((p) => ({ x: p.x, y: p.y })) },
		created_at: now,
		updated_at: now
	};
}

export function maxZOf(objects: readonly CanvasObject[]): number {
	return objects.reduce((z, o) => Math.max(z, o.transform.z), 0);
}
