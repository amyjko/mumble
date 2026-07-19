import type { Participant, Point, StoredIdentity } from './types';

/**
 * Avatar facts, in the model rather than in the stub backend.
 *
 * `AVATAR_SIZE` and `AVATAR_BORDER` lived in memory-store.svelte.ts — a
 * deliberately disposable localStorage stub — while being read by three
 * components, the schema layer, and the collision solver. They are product
 * facts, and the file most likely to be deleted is the wrong home for them.
 */

/** Default avatar edge, in world pixels. */
export const AVATAR_SIZE = 96;

/**
 * Avatars carry a sticker border like objects do (UX-OBJ-8), which is also
 * their overlap tolerance (UX-OBJ-12).
 */
export const AVATAR_BORDER = 6;

/**
 * Birth a participant.
 *
 * `create.ts` has had `newNote`/`newTimer`/`newChat`/`newDrawing` since the
 * beginning and no `newParticipant`, so the defaults for the one entity every
 * session creates were written out in Room.svelte and again in DevPanel — and
 * one of those defaults, `muted: true`, is a stated requirement (UX-STAGE-10:
 * you arrive silent and opt in). A requirement duplicated into a dev panel is
 * a requirement that will be changed in one place.
 *
 * `existing` carries an avatar's own size/shape/state across a rejoin
 * (UX-AV-1/9); pass nothing for a genuinely new participant.
 */
export function newParticipant(
	identity: StoredIdentity,
	options: { fake?: boolean; at?: Point; existing?: Participant | undefined } = {}
): Participant {
	const { fake = false, at, existing } = options;
	return {
		id: identity.id,
		name: identity.name,
		emoji: identity.emoji,
		location: existing?.location ?? at ?? { x: 0, y: 0 },
		size: existing?.size ?? { width: AVATAR_SIZE, height: AVATAR_SIZE },
		rotation: existing?.rotation ?? 0,
		clip: existing?.clip ?? { shape: 'circle' },
		fake,
		away: existing?.away ?? false,
		// UX-STAGE-10: you arrive silent and opt in by unmuting, which is also
		// what stops a rejoin silently re-taking an audio slot.
		muted: existing?.muted ?? true
	};
}
