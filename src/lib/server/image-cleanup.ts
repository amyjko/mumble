import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import type { RoomState } from '$lib/model/types';
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
