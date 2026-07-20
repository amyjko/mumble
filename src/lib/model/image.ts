/**
 * Image caps (UX-OBJ-5), single-sourced here so the client pre-check, the zod
 * schema (the server gate for dimensions), and the Storage bucket migration all
 * quote one set of numbers. The SQL half restates the byte cap and mime list in
 * the bucket definition with a comment pointing back here — the same
 * cross-boundary duplication `DEFAULT_CAPACITY` already lives with, because a
 * migration cannot import TypeScript.
 *
 * Two of the three caps have a real gate below the client:
 *  - BYTES and MIME are enforced by the bucket (`file_size_limit`,
 *    `allowed_mime_types`) — the storage API refuses an oversize or wrong-type
 *    upload and a patched client cannot bypass it.
 *  - DIMENSIONS have no storage-side gate (Storage never decodes the bytes), so
 *    the client decodes and refuses, and the zod schema caps width/height so the
 *    mutate route rejects a `create_object` that claims oversize dimensions. A
 *    patched client can still upload a within-byte image and LIE about its
 *    dimensions in the payload; that degrades only its own render and cannot
 *    exceed the byte cap, which is the real resource bound. An authoritative
 *    dimension gate would need server-side decode (out of MVP scope).
 */

/**
 * 2 MB. Ample for a screenshot, diagram, or a reasonably-compressed photo, and
 * deliberately NOT generous: there is no thumbnailing yet (image_transformation
 * is Pro-tier), so every viewer downloads every image at full source bytes. A
 * low per-image cap is the only thing bounding what a room costs to load until
 * downscaled renditions exist — see the note on MAX_IMAGES_PER_ROOM.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Max pixels on either side. 4096 covers a 4K display at fullscreen (UX-CANVAS-4)
 * with room to spare, while bounding client DECODE memory — which matters more
 * than bytes once a room holds a couple of dozen images open at once.
 */
export const MAX_IMAGE_DIM = 4096;

/**
 * How many images one room may hold (UX-OBJ-5). The per-image byte cap bounds a
 * single upload; this bounds the ROOM, because 25 × 2 MB is a load a viewer can
 * carry and 100 images is not. A count rather than an aggregate-byte budget on
 * purpose: it needs no running total and gives a message a person can act on
 * ("the room is full of images") rather than a byte figure they cannot picture.
 * Enforced in the rule engine (the server gate) and pre-checked in the UI.
 */
export const MAX_IMAGES_PER_ROOM = 25;

/**
 * The formats worth accepting: lossy photo (jpeg), lossless/transparent (png),
 * modern (webp), and animated (gif). Kept in lockstep with the bucket's
 * `allowed_mime_types`.
 */
export const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export type ImageMime = (typeof ALLOWED_IMAGE_MIME)[number];
