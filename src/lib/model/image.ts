// Type-only, so no runtime cycle with types.ts (which re-exports schema types
// that reference the constants below).
import type { RoomState } from './types';

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

/**
 * The Storage bucket for image bytes (UX-OBJ-5, AR-BACKEND-1). Private: read is
 * gated by the same room-membership RLS as every other object, so image access
 * cannot outrun room access. The migration is `..._image_storage.sql`.
 *
 * Lives HERE, in the dependency-free constants module, rather than in
 * `image-upload.ts`: both the client (upload) and the server route (delete a
 * blob when its object is deleted) need it, and the server route must not pull
 * the client upload code (`createImageBitmap`) into the worker bundle to get a
 * bucket name.
 */
export const IMAGE_BUCKET = 'room-images';

/**
 * A signed URL that errors sooner than this after being minted is treated as a
 * genuine failure (a deleted blob, a network fault) rather than an expiry — so
 * the render layer does NOT re-mint it, which would loop forever on a dead blob.
 * Comfortably shorter than the TTL (SIGNED_URL_TTL_SECONDS), so a real ~1 h
 * expiry always reads as an expiry and refreshes. See `shouldRefreshSignedUrl`.
 */
export const SIGNED_URL_MIN_AGE_BEFORE_REFRESH_MS = 30_000;

/**
 * Whether an image whose `<img>` just errored should have its signed URL
 * re-minted. True only if the current URL is old enough to have plausibly
 * expired; a fresh URL that already fails is a dead blob, and re-minting it
 * would produce another URL that fails immediately — an infinite loop. Pure, so
 * the decision is testable without the render layer.
 */
export function shouldRefreshSignedUrl(mintedAt: number | undefined, now: number): boolean {
	if (mintedAt === undefined) return true;
	return now - mintedAt >= SIGNED_URL_MIN_AGE_BEFORE_REFRESH_MS;
}

/**
 * The Storage keys to delete when a set of objects is removed (UX-OBJ-5).
 *
 * An image's bytes live outside room state, so deleting the object must delete
 * the blob too — otherwise it orphans. The removed ids carry no payload (the
 * diff drops the whole record), so the path is read from the PRE-mutation state.
 * Pure, so the server route's cleanup is testable without Storage.
 */
export function imageBlobsToDelete(before: RoomState, removedIds: readonly string[]): string[] {
	const paths: string[] = [];
	for (const id of removedIds) {
		const object = before.objects[id];
		if (object?.type === 'image') paths.push(object.payload.path);
	}
	return paths;
}
