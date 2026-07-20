import type { SupabaseClient } from '@supabase/supabase-js';
import type { ImageRef } from '$lib/model/create';
import {
	ALLOWED_IMAGE_MIME,
	IMAGE_BUCKET,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_DIM,
	type ImageMime
} from '$lib/model/image';

// IMAGE_BUCKET now lives in model/image.ts (dependency-free, shared with the
// server route that deletes blobs). Re-exported here so existing importers of
// `$lib/media/image-upload` keep working.
export { IMAGE_BUCKET };

/** How long a minted signed URL stays valid. Long enough to sit open in a
    meeting; refreshed by the render layer when it lapses (shouldRefreshSignedUrl). */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * A refusal a person should see (UX-OBJ-5's caps, or a storage error). Its
 * message is user-facing — Room announces it through the live region, the same
 * way a StoreRejection surfaces.
 */
export class ImageUploadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ImageUploadError';
	}
}

function isAllowedMime(type: string): type is ImageMime {
	return ALLOWED_IMAGE_MIME.some((allowed) => allowed === type);
}

/**
 * The CLIENT half of the size cap — the responsive, friendly gate (UX-OBJ-5).
 * Bytes and mime also have a real gate below this (the bucket's
 * `file_size_limit` / `allowed_mime_types`, which a patched client cannot
 * bypass); dimensions do NOT — Storage never decodes the bytes — so this decode
 * plus the zod cap on the payload is the whole dimension story. See
 * model/image.ts.
 *
 * Pure and Supabase-free so it is testable with a canvas-generated blob.
 */
export async function validateImageFile(
	file: File
): Promise<{ width: number; height: number; mime: ImageMime }> {
	if (!isAllowedMime(file.type)) {
		throw new ImageUploadError('That file type is not a supported image (PNG, JPEG, WebP, or GIF)');
	}
	if (file.size > MAX_IMAGE_BYTES) {
		const mb = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));
		throw new ImageUploadError(`That image is too large — the limit is ${String(mb)} MB`);
	}
	const { width, height } = await decodeDimensions(file);
	if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
		throw new ImageUploadError(
			`That image is too big — the limit is ${String(MAX_IMAGE_DIM)} pixels on a side`
		);
	}
	return { width, height, mime: file.type };
}

/**
 * Decode just far enough to read the pixel dimensions. `createImageBitmap`
 * fully decodes and rejects a malformed image — which is the point: a file that
 * cannot be decoded is not an image we should store, and catching it here beats
 * uploading bytes that would never render.
 */
async function decodeDimensions(file: File): Promise<{ width: number; height: number }> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		throw new ImageUploadError('That image could not be read');
	}
	const { width, height } = bitmap;
	bitmap.close();
	return { width, height };
}

/** The filename without its extension — a non-empty accessible name by
    default (UX-A11Y-3), editable afterwards via `set_image_alt`. */
function altFromFilename(name: string): string {
	return name.replace(/\.[^.]+$/, '').trim();
}

/**
 * Validate, upload the bytes to Storage, and return the reference the object
 * will carry (AR-CANVAS-3). The bytes take the Storage path directly — NOT the
 * mutate route (AR-SYNC-3 governs room STATE; opaque bytes are Storage's job) —
 * gated by the bucket's RLS. Only the resulting object goes through the control
 * plane.
 *
 * The key is `<room_id>/<uuid>`: the room segment is what storage RLS
 * authorizes on, so it must come first.
 */
export async function uploadImage(
	client: SupabaseClient,
	file: File,
	roomId: string
): Promise<ImageRef> {
	const { width, height, mime } = await validateImageFile(file);
	const path = `${roomId}/${crypto.randomUUID()}`;
	const { error } = await client.storage.from(IMAGE_BUCKET).upload(path, file, {
		contentType: mime,
		upsert: false
	});
	if (error) {
		// The bucket's own caps land here too (oversize/wrong-type that slipped the
		// client check), so the message stays generic rather than guessing which.
		throw new ImageUploadError('That image could not be uploaded');
	}
	return { path, width, height, mime, alt: altFromFilename(file.name) };
}
