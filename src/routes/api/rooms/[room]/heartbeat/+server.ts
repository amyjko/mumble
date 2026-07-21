import { json, error, type RequestHandler } from '@sveltejs/kit';
import { parseClaims } from '$lib/auth/claims';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import { canonicalRoomName } from '$lib/model/room-name';
import { loadRoomState, saveRoomState, VersionConflict } from '$lib/server/room-state';
import { diffRoomState } from '$lib/model/diff';
import { reapParticipants } from '$lib/model/rules';
import { closeIntervals, meterBeat } from '$lib/server/ledger';
import { STALE_AFTER_SECONDS } from '$lib/model/ledger';

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
 *
 * IT IS ALSO THE METER (AR-COST-3, UX-ECON-2), as of the ledger landing, and
 * the migration that added `last_seen` predicted exactly this: "the metering
 * half waits for the ledger and can reuse this beat when it lands." The reuse
 * is not opportunism. UX-ECON-2 requires time to be metered "reliably even
 * across crashes", and a beat is the only signal this system has that survives
 * one — a leave event is precisely what a crash fails to send. Every credited
 * second is one where somebody said they were still here.
 *
 * `STALE_AFTER_SECONDS` now lives in `model/ledger.ts`, because the staleness
 * threshold and the metering clamp are one number; see the comment there for
 * why they must stay one.
 */

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
	 *
	 * Read the PREVIOUS `last_seen` first: the gap between it and now is what
	 * this beat is worth, and overwriting it before reading would destroy the
	 * only record of how long the beater has been present. The metering credit
	 * rides the same reasoning as the write — outside the diff path, so the
	 * meter cannot turn an idle room into a busy one either.
	 */
	const previous = await db
		.from('room_participants')
		.select('last_seen')
		.eq('room_id', room.data.id)
		.eq('id', claims.sub)
		.maybeSingle();

	const now = new Date();
	await db
		.from('room_participants')
		.update({ last_seen: now.toISOString() })
		.eq('room_id', room.data.id)
		.eq('id', claims.sub);

	/*
	 * Credit the room's OWNER, not the beater (UX-ID-4). A guest holds no
	 * account by design, so there is no other coherent place for their seconds
	 * to land — and it is the owner who chose to run the room.
	 *
	 * Not awaited for correctness, but awaited anyway: the beat is already a
	 * round trip, one more is not what makes it slow, and an un-awaited write in
	 * workerd is a write that may never happen (the isolate can be torn down
	 * when the response is sent — the unsettled-write bug this suite was just
	 * burned by).
	 */
	await meterBeat(
		db,
		room.data.id,
		claims.sub,
		previous.data === null ? null : new Date(previous.data.last_seen),
		now
	);

	const cutoff = new Date(Date.now() - STALE_AFTER_SECONDS * 1000).toISOString();
	const stale = await db
		.from('room_participants')
		.select('id')
		.eq('room_id', room.data.id)
		.lt('last_seen', cutoff);

	const gone = (stale.data ?? []).map((row) => row.id);
	if (gone.length === 0) return json({ ok: true, reaped: 0 });

	/*
	 * Stamp their ledger intervals closed (AR-COST-2). Audit trail only: it
	 * moves no seconds, because their seconds were credited beat by beat as
	 * they were spent. Done BEFORE the state write and unconditionally, so a
	 * sweep that loses all three attempts at the room guard still records that
	 * these people stopped being here — a closed interval is a fact about
	 * presence, not about whether a room-state write happened to win a race.
	 */
	await closeIntervals(db, room.data.id, gone);

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
