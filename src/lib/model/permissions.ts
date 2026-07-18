import type { CanvasObject } from './types';

/**
 * UX-PERM-1..2, pure and node-tested. The creator can always edit or delete
 * their own object regardless of `permission`; otherwise `all` admits anyone,
 * `none` admits nobody, and `host` admits hosts. Slice 1 has no host role yet
 * (admission lands later), so `isHost` is threaded through but always false
 * at the call sites — the logic is complete even though the role isn't.
 */
export function canEdit(object: CanvasObject, actorId: string, isHost: boolean): boolean {
	if (object.creator_id === actorId) return true;
	switch (object.permission) {
		case 'all':
			return true;
		case 'host':
			return isHost;
		case 'none':
			return false;
	}
}

/** UX-PERM-2: deletion follows the same rule as editing. */
export const canDelete = canEdit;
