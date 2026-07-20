import { json, error, type RequestHandler } from '@sveltejs/kit';
import { parseClaims } from '$lib/auth/claims';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import { canonicalRoomName } from '$lib/model/room-name';
import { loadRoomState, saveRoomState, VersionConflict } from '$lib/server/room-state';
import { diffRoomState } from '$lib/model/diff';
import { reapParticipants } from '$lib/model/rules';

/**
 * "I am still here", and a sweep of everyone who is not (AR-CTRL-3, UX-STAGE-4).
 *
 * Presence already reaps a departed holder within a second, and that remains
 * the fast path. This is the BACKSTOP for the hole presence cannot cover:
 * presence-driven reaping is client-side and host-only, so a room whose only
 * host has left keeps its ghosts — and at `max_av = 1` a ghost holds the conch,
 * which means the room is silent until a human intervenes.
 *
 * The sweep runs HERE rather than on a schedule, and that is the design rather
 * than a shortcut. pg_cron is not enabled (AR-COST-6 notes it), and a scheduled
 * job would run against thousands of idle rooms to find nothing. Anyone still
 * in a room sweeps it; a room with nobody in it needs no sweeping, and the next
 * arrival cleans up before anything else happens.
 *
 * Staleness is measured from timestamps the SERVER writes, never from a claim,
 * so this needs no authorization beyond membership: a caller cannot assert that
 * somebody else is gone. That is also why it uses `reapParticipants` — which
 * takes no actor and is unreachable from the mutation union — rather than the
 * user-facing `remove_participant`, which stays self-or-host.
 */

/**
 * Three missed beats at the client's ~15s cadence.
 *
 * Generous on purpose. Reaping someone who is merely on a slow network takes
 * the conch from a person still sitting in the room, which is a worse failure
 * than a ghost lingering a few seconds longer — and presence already handles
 * the common case in about a second.
 */
const STALE_AFTER_SECONDS = 45;

export const POST: RequestHandler = async ({ params, locals }) => {
	const claims = parseClaims(await locals.safeGetClaims());
	if (claims === null) error(401, 'Not signed in');

	const db = supabaseAdmin();
	const name = canonicalRoomName(params.room ?? '');
	const room = await db.from('rooms').select('id').eq('name', name).maybeSingle();
	if (room.data === null) error(404, 'No such room');

	const membership = await db
		.from('room_members')
		.select('status')
		.eq('room_id', room.data.id)
		.eq('identity_id', claims.sub)
		.maybeSingle();
	if (membership.data === null || membership.data.status !== 'admitted') {
		error(403, 'Not a member of this room');
	}

	/*
	 * The beat itself: a direct column write, deliberately OUTSIDE the diff and
	 * version path. Room state is diffed, versioned and broadcast on every
	 * write, so heartbeating through it would turn an idle room into one
	 * producing a write and a fan-out per participant every fifteen seconds.
	 * Nothing renders `last_seen`, so nothing needs to hear about it.
	 */
	await db
		.from('room_participants')
		.update({ last_seen: new Date().toISOString() })
		.eq('room_id', room.data.id)
		.eq('id', claims.sub);

	const cutoff = new Date(Date.now() - STALE_AFTER_SECONDS * 1000).toISOString();
	const stale = await db
		.from('room_participants')
		.select('id')
		.eq('room_id', room.data.id)
		.lt('last_seen', cutoff);

	const gone = (stale.data ?? []).map((row) => row.id);
	if (gone.length === 0) return json({ ok: true, reaped: 0 });

	/*
	 * Bounded retry, as the mutation route does: the sweep changes room scalars
	 * (holder lists), so it takes the room guard and can lose a race with a
	 * concurrent write. Losing is harmless — the next beat sweeps again — but
	 * retrying makes the common case land immediately.
	 */
	for (let attempt = 0; attempt < 3; attempt++) {
		const room_state = await loadRoomState(db, room.data.id);
		if (room_state === null) error(404, 'No such room');

		const before = structuredClone(room_state.state);
		reapParticipants(room_state.state, gone);
		const diff = diffRoomState(before, room_state.state);
		if (diff.empty) return json({ ok: true, reaped: 0 });

		try {
			await saveRoomState(db, room.data.id, room_state.version, diff, room_state.objectVersions);
			return json({ ok: true, reaped: gone.length });
		} catch (conflict) {
			if (!(conflict instanceof VersionConflict)) throw conflict;
		}
	}

	// Not an error the caller should act on: the next beat will try again.
	return json({ ok: true, reaped: 0 });
};
