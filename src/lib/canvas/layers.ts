/**
 * Stacking order INSIDE the world layer.
 *
 * These are meaningful only because `.canvas` sets `isolation: isolate` — the
 * world has its own stacking context, so these numbers never compete with page
 * chrome (which uses the single-digit --z-* tokens in app.css).
 *
 * These live here rather than in each component's CSS because they are ONE
 * RELATIONSHIP, not independent numbers: placers sit under people, people sit
 * over content, and anything hovered rises over all of it. Split across files,
 * an edit to one silently breaks another.
 *
 * That is not hypothetical. PLACER_Z was written as a bare `900` inside
 * PlacerMarker's CSS while the other two were named here — the exact split
 * this comment warns against, in the same file it warns in. layers.spec.ts now
 * asserts the ordering so the relationship is checked rather than described.
 */

/**
 * Newcomer placers rest BELOW avatars: a placer marks where a person will be,
 * so a person standing in one must not be hidden by it. They rise to RAISED_Z
 * on hover or focus, which is what keeps their controls reachable when someone
 * is standing in them.
 */
export const PLACER_Z = 900;

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
