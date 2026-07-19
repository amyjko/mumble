/**
 * The emote vocabulary (UX-AV-4/5), in one place — and the source of truth
 * DESIGN.md's UX-AV-4 now enumerates. `heart` and `laugh` shipped here before
 * the requirement listed them; rather than delete working emotes or leave the
 * drift, UX-AV-4 was amended to match (2026-07-18).
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

/**
 * Glyphs for the PERSISTENT states (UX-AV-5). They live here beside the
 * transient ones rather than as literals in markup for the same reason colors
 * live in palette.ts: emoji must render through --font-emoji, and keeping every
 * glyph in data is what lets no-raw-emoji.spec.ts enforce that mechanically.
 */
export const HAND_EMOJI = '✋';
export const AWAY_EMOJI = '💤';

/** Slot-state glyphs (UX-STAGE-9): who holds what, shown on their avatar. */
export const VIDEO_EMOJI = '\u{1F3A5}';
export const MIC_EMOJI = '\u{1F3A4}';
export const MUTED_EMOJI = '\u{1F507}';

/**
 * Glyphs for the "add" controls. Data, not markup, so every render goes
 * through <Emoji> and therefore --font-emoji — enforced by no-raw-emoji.spec.
 *
 * A "+ note" button says what it does but gives the eye nothing to aim at; in
 * a row of four the words are the only thing distinguishing them.
 */
export const ADD_EMOJI = {
	note: '\u{1F4DD}',
	timer: '\u{23F1}\u{FE0F}',
	chat: '\u{1F4AC}',
	drawing: '\u{270F}\u{FE0F}',
	placer: '\u{1F4CD}'
} as const;
