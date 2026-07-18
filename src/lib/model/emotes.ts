/**
 * The emote vocabulary (UX-AV-4/5), in one place.
 *
 * The six-name union used to be written out longhand in three files
 * (schemas.ts, sync-client, AvatarTile), so adding an emote meant editing all
 * three and the type could drift from the glyphs. EMOTE_NAMES is the source;
 * schemas derives its enum from it.
 */

export const EMOTE_NAMES = ['tada', 'bounce', 'bored', 'spin', 'heart', 'laugh'] as const;

export type EmoteName = (typeof EMOTE_NAMES)[number];

/** Glyph per emote — shared by the launcher and the avatar's float animation. */
export const EMOTE_EMOJI: Record<EmoteName, string> = {
	tada: '🎉',
	bounce: '⬆️',
	bored: '😴',
	spin: '🌀',
	heart: '💜',
	laugh: '😂'
};

/** Human labels, so a launcher button has a real accessible name. */
export const EMOTE_LABEL: Record<EmoteName, string> = {
	tada: 'Celebrate',
	bounce: 'Excited',
	bored: 'Bored',
	spin: 'Spin',
	heart: 'Heart',
	laugh: 'Laugh'
};
