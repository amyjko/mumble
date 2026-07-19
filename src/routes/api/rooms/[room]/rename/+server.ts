import { json, error, type RequestHandler } from '@sveltejs/kit';
import { z } from 'zod';
import { parseClaims } from '$lib/auth/claims';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import { canonicalRoomName, roomNameProblem, roomNameMessage } from '$lib/model/room-name';

/**
 * Rename a room (UX-ROOM-10, AR-BACKEND-10).
 *
 * Renaming lived only in the browser stub, which copied one localStorage key to
 * another and navigated — so the new URL resolved because the stub conjured a
 * room for any name, and the old one kept working because nothing was freed.
 * Its own comment admitted both. Against Postgres the copy means nothing and
 * the new name simply 404s, which is how the switchover surfaced this.
 *
 * A route rather than a mutation, because the name is not room STATE: it lives
 * on `rooms`, it is the address, and `mutationSchema` describes the contents of
 * a room rather than its identity. It is written with the admin client for the
 * same reason every other write is — clients hold SELECT and nothing more.
 *
 * The rename is genuine: the old name is FREED by the same update, so old links
 * stop resolving. That is the consequence hosts are warned about before they
 * confirm, and it is now true rather than merely stated.
 */
const body = z.object({ name: z.string() });

export const POST: RequestHandler = async ({ request, params, locals }) => {
	const claims = parseClaims(await locals.safeGetClaims());
	if (claims === null) error(401, 'Not signed in');

	const parsed = body.safeParse(await request.json());
	if (!parsed.success) error(400, 'Malformed request');

	const next = canonicalRoomName(parsed.data.name);
	const problem = roomNameProblem(next);
	// Validated HERE, not only in the UI: the UI's copy exists to explain the
	// rule while typing, and is not a gate.
	if (problem !== null) error(400, roomNameMessage(problem));

	const db = supabaseAdmin();
	const current = canonicalRoomName(params.room ?? '');
	if (next === current) error(400, 'That is already this room’s name.');

	const room = await db.from('rooms').select('id').eq('name', current).maybeSingle();
	if (room.data === null) error(404, 'No such room');

	// Host-only, read from the same membership row the RLS policies consult, so
	// a request cannot claim a role it does not hold (UX-PERM-3).
	const membership = await db
		.from('room_members')
		.select('role, status')
		.eq('room_id', room.data.id)
		.eq('identity_id', claims.sub)
		.maybeSingle();
	if (membership.data === null || membership.data.status !== 'admitted') {
		error(403, 'Not a member of this room');
	}
	if (membership.data.role !== 'host') error(403, 'Only a host can rename this room');

	const { error: failure } = await db.from('rooms').update({ name: next }).eq('id', room.data.id);
	if (failure !== null) {
		// 23505 is unique_violation: `rooms.name` is a unique citext column, so
		// the race between checking and taking a name is settled by the database
		// rather than by a check-then-act that two hosts could both pass.
		if (failure.code === '23505') error(409, 'That name is taken.');
		throw new Error(failure.message);
	}

	return json({ ok: true, name: next });
};
