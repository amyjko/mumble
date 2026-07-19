import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '$lib/database.types';
import type { RoomState } from '$lib/model/types';
import { z } from 'zod';
import { roomStateSchema } from '$lib/model/schemas';
import type { RoomStateDiff } from '$lib/model/diff';

/**
 * The RPC's envelope. Parsed rather than asserted: `rpc()` returns Json, and
 * this project bans `as` precisely so a shape coming from outside gets checked
 * once at the boundary instead of assumed everywhere after it.
 */
const envelopeSchema = z.object({ version: z.number(), state: z.unknown() });

/**
 * A plain-data copy for the wire.
 *
 * `JSON.parse` returns `any`, which the no-unsafe-* rules refuse — and refuse
 * for a good reason here, since this value is about to be handed to SQL. The
 * round trip itself is necessary: Svelte `$state` proxies do not survive
 * serialisation intact, and sending one produces something the function cannot
 * read, silently.
 */
function plainJson(value: RoomStateDiff): Json {
	const copy: unknown = JSON.parse(JSON.stringify(value));
	// Validated against the generated `Json` shape rather than cast into it.
	const json: z.ZodType<Json> = z.lazy(() =>
		z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(json), z.record(z.string(), json)])
	);
	const parsed = json.safeParse(copy);
	if (!parsed.success) throw new Error('room state did not serialise to JSON');
	return parsed.data;
}

/**
 * Room state, read and written as a whole (AR-BACKEND-4, AR-SYNC-3).
 *
 * Both directions are ONE call into SQL. Reading that way gives a consistent
 * snapshot — five PostgREST queries can interleave with a write and produce
 * objects from before it and participants from after. Writing that way is
 * transactional, which the per-table version was not: a failure midway left a
 * room partially written.
 *
 * The shape is `roomStateSchema`, the same schema the canvas renders and the
 * rule engine mutates, so the database is a projection of one model rather than
 * a second definition of it.
 */

export interface LoadedRoom {
	state: RoomState;
	/** For the compare-and-swap on write. A stale writer re-reads. */
	version: number;
}

export async function loadRoomState(
	db: SupabaseClient<Database>,
	roomId: string
): Promise<LoadedRoom | null> {
	const { data, error } = await db.rpc('get_room_state', { p_room_id: roomId });
	if (error !== null || data === null) return null;

	const envelope = envelopeSchema.safeParse(data);
	if (!envelope.success) throw new Error(`room ${roomId} returned an unreadable envelope`);
	const parsed = roomStateSchema.safeParse(envelope.data.state);
	// A row that no longer satisfies the schema is a bug to surface, not one to
	// paper over with defaults — the stub warns and starts fresh, which a server
	// may not do to someone's room.
	if (!parsed.success) throw new Error(`room ${roomId} failed validation: ${parsed.error.message}`);
	return { state: parsed.data, version: envelope.data.version };
}

/** Thrown when someone else committed first. The caller re-reads and retries. */
export class VersionConflict extends Error {}

export async function saveRoomState(
	db: SupabaseClient<Database>,
	roomId: string,
	expectedVersion: number,
	diff: RoomStateDiff
): Promise<number> {
	const { data, error } = await db.rpc('save_room_state', {
		p_room_id: roomId,
		p_expected_version: expectedVersion,
		p_diff: plainJson(diff)
	});
	if (error !== null) {
		// 40001 is serialization_failure, raised by the CAS when the version
		// moved under us. Distinguished from a real failure so the route can
		// retry rather than reporting a fault to the user.
		if (error.code === '40001') throw new VersionConflict(error.message);
		throw new Error(error.message);
	}
	return data;
}
