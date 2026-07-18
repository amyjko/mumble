import { describe, expect, it } from 'vitest';
import { canEdit } from './permissions';
import type { CanvasObject, Permission } from './types';

const CREATOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const note = (permission: Permission): CanvasObject => ({
	id: '33333333-3333-4333-8333-333333333333',
	type: 'note',
	creator_id: CREATOR,
	permission,
	transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0, z: 1 },
	clip: { shape: 'rect' },
	border: { width: 10 },
	default_transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0, z: 1 },
	payload: { text: '' },
	created_at: '2026-07-17T00:00:00.000Z',
	updated_at: '2026-07-17T00:00:00.000Z'
});

/** The full UX-PERM-1..2 matrix: permission × actor × host. */
describe('canEdit', () => {
	it.each([
		// permission, actor,   isHost, expected
		['all', CREATOR, false, true],
		['all', OTHER, false, true],
		['host', CREATOR, false, true], // creator override beats `host`
		['host', OTHER, false, false],
		['host', OTHER, true, true],
		['none', CREATOR, false, true], // creator override beats `none`
		['none', OTHER, false, false],
		['none', OTHER, true, false] // `none` locks out even hosts (UX-PERM-1)
	] satisfies [Permission, string, boolean, boolean][])(
		'permission=%s actor=%s host=%s → %s',
		(permission, actor, isHost, expected) => {
			expect(canEdit(note(permission), actor, isHost)).toBe(expected);
		}
	);
});
