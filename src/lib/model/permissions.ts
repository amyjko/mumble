import type { CanvasObject, Permission } from './types';

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

/**
 * Who may lay out newcomer placers (UX-AV-2): a room-design privilege, not an
 * object one, so it takes no object and asks only about the role.
 *
 * Was deliberately permissive while no role existed — gating on a literal
 * `false` would have hidden placers from everyone and shipped the feature dead,
 * the same defect as a `create_permission: 'host'` that admits nobody. The role
 * exists now (room_members), so the gate is the gate.
 */
export function canDesignRoom(isHost: boolean): boolean {
	return isHost;
}

/**
 * Glyphs for each permission (UX-PERM-1). Data, not markup, so every render
 * goes through <Emoji> and therefore --font-emoji — enforced by
 * no-raw-emoji.spec.ts, which caught these as literals when they were written
 * inline.
 */
export const PERMISSION_EMOJI: Record<Permission, string> = {
	all: '\u{1F513}',
	host: '\u{1F6E1}\u{FE0F}',
	none: '\u{1F512}'
};

export const PERMISSION_LABEL: Record<Permission, string> = {
	all: 'Anyone can edit',
	host: 'Hosts can edit',
	none: 'Only you can edit'
};
