import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import type { Mutation, RoomState } from '$lib/model/types';
import { IMAGE_BUCKET, imageBlobsToDelete } from '$lib/model/image';

/**
 * Delete the Storage blobs of any image objects removed by a commit (UX-OBJ-5).
 *
 * Called by the mutate route AFTER the row commit succeeds, never before — a
 * failed blob delete then only orphans a blob (recoverable by a later sweep, and
 * the status quo the bucket was built to tolerate: no client DELETE policy),
 * whereas deleting bytes ahead of a commit that rolled back would lose a live
 * image. Errors are swallowed for that reason.
 *
 * Split from the route so the real Storage interaction is testable on its own
 * (`image-cleanup.integration.spec.ts`) without constructing an HTTP request.
 * Returns the paths it attempted, for tests and observability.
 */
export async function deleteImageBlobs(
	db: SupabaseClient<Database>,
	before: RoomState,
	removedIds: readonly string[]
): Promise<string[]> {
	const paths = imageBlobsToDelete(before, removedIds);
	if (paths.length === 0) return paths;
	await db.storage
		.from(IMAGE_BUCKET)
		.remove(paths)
		.catch(() => undefined);
	return paths;
}

/**
 * Delete the blob of an image whose `create_object` was just REJECTED (UX-OBJ-5).
 *
 * The bytes upload before the create is committed, so a rejected create leaves
 * an orphan. The client's `mayCreate`/count pre-checks stop the common cases
 * before any upload; this is the server-side backstop for the races that slip a
 * create through to a rejection (create-permission or the last slot changing
 * between pre-check and commit). The rejected mutation still carries the path, so
 * no client DELETE grant is needed. A no-op for any other mutation. Swallowed for
 * the same reason as the delete path.
 */
export async function deleteImageBlobForRejectedCreate(
	db: SupabaseClient<Database>,
	mutation: Mutation
): Promise<void> {
	if (mutation.kind !== 'create_object' || mutation.object.type !== 'image') return;
	await db.storage
		.from(IMAGE_BUCKET)
		.remove([mutation.object.payload.path])
		.catch(() => undefined);
}
