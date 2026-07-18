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

/**
 * Who can SEE a hidden object (UX-ROOM-3). Hiding is a layout property, not a
 * deletion: the object still exists for everyone, but only its creator — and,
 * once the role exists, a host — can see it while hidden.
 *
 * `isHost` is threaded through and passed `false` at every call site today,
 * exactly as `canEdit` was written before the host role existed. So this ships
 * as CREATOR-ONLY visibility; the host half lights up for free when admission
 * lands (AR-BACKEND-*). Stated plainly so it is not later mistaken for a bug.
 */
export function canSee(object: CanvasObject, actorId: string, isHost: boolean): boolean {
	if (!object.hidden) return true;
	return object.creator_id === actorId || isHost;
}
