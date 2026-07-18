import type { CanvasObject, Point } from './types';
import { nowIso } from './types';

/**
 * The one place notes are born — used by the canvas double-click AND the
 * header's "+ note" button (UX-A11Y-2: creation must not require a pointer).
 */
export function newNote(creatorId: string, center: Point, maxZ: number): CanvasObject {
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
		border: { width: 10 },
		default_transform: transform,
		payload: { text: '' },
		created_at: now,
		updated_at: now
	};
}

/** A paused 5-minute countdown by default — a sensible starting shape. */
export function newTimer(creatorId: string, center: Point, maxZ: number): CanvasObject {
	const now = nowIso();
	const transform = {
		x: center.x - 90,
		y: center.y - 60,
		width: 180,
		height: 120,
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
		border: { width: 10 },
		default_transform: transform,
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

export function maxZOf(objects: readonly CanvasObject[]): number {
	return objects.reduce((z, o) => Math.max(z, o.transform.z), 0);
}
