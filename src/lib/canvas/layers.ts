/**
 * Stacking order INSIDE the world layer.
 *
 * These are meaningful only because `.canvas` sets `isolation: isolate` — the
 * world has its own stacking context, so these numbers never compete with page
 * chrome (which uses the single-digit --z-* tokens in app.css).
 *
 * Both values live here rather than in each component's CSS because they are a
 * relationship, not two independent numbers: the whole point of RAISED_Z is
 * that it beats AVATAR_Z. Split across two files, a later edit to one silently
 * breaks the other.
 */

/** Avatars sit above settled objects, so people are never buried by content. */
export const AVATAR_Z = 1000;

/**
 * A hovered or focused object rises above EVERYTHING in the world, avatars
 * included. Overlap is legal up to the sticker border (UX-OBJ-12), so an
 * avatar or a higher-z neighbor routinely covers an object's corner handles —
 * and a control you cannot reach is a control you do not have. Raising on
 * hover/focus is what makes the chrome reachable in the overlap zone.
 */
export const RAISED_Z = 1100;
