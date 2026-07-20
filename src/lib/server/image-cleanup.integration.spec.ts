import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { SUPABASE_SECRET_KEY } from '$env/static/private';
import type { Database } from '$lib/database.types';
import type { RoomState } from '$lib/model/types';
import { roomStateSchema } from '$lib/model/schemas';
import { newImage } from '$lib/model/create';
import { IMAGE_BUCKET } from '$lib/model/image';
import { deleteImageBlobs } from './image-cleanup';

/**
 * Blob cleanup against REAL local Storage (UX-OBJ-5).
 *
 * The unit test proves `imageBlobsToDelete` picks the right paths; this proves
 * the bytes actually leave the bucket. Below the HTTP route, like the other
 * integration specs — the route's own line is a single `deleteImageBlobs` call,
 * and a browser would add only noise to "did the object get removed from
 * Storage".
 */

const db: SupabaseClient<Database> = createClient<Database>(
	PUBLIC_SUPABASE_URL,
	SUPABASE_SECRET_KEY,
	{ auth: { autoRefreshToken: false, persistSession: false } }
);

const CREATOR = '00000000-0000-4000-8000-000000000000';

function stateWithImageAt(path: string): { before: RoomState; id: string } {
	const before = roomStateSchema.parse({ objects: {}, participants: {} });
	const object = newImage(CREATOR, { x: 0, y: 0 }, 0, {
		path,
		width: 4,
		height: 4,
		mime: 'image/png',
		alt: 'x'
	});
	before.objects[object.id] = object;
	return { before, id: object.id };
}

async function fileCount(folder: string): Promise<number> {
	const { data } = await db.storage.from(IMAGE_BUCKET).list(folder);
	return data?.length ?? 0;
}

describe('deleteImageBlobs against real Storage', () => {
	it('removes the blob of a deleted image object', async () => {
		const folder = crypto.randomUUID();
		const path = `${folder}/${crypto.randomUUID()}`;
		const upload = await db.storage
			.from(IMAGE_BUCKET)
			.upload(path, new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }), {
				contentType: 'image/png'
			});
		expect(upload.error).toBeNull();
		expect(await fileCount(folder)).toBe(1);

		const { before, id } = stateWithImageAt(path);
		const removed = await deleteImageBlobs(db, before, [id]);

		expect(removed).toEqual([path]);
		expect(await fileCount(folder)).toBe(0);
	});

	it('touches Storage for nothing when no image was removed', async () => {
		const before = roomStateSchema.parse({ objects: {}, participants: {} });
		expect(await deleteImageBlobs(db, before, [crypto.randomUUID()])).toEqual([]);
	});
});
