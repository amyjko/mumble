import { json, error, type RequestHandler } from '@sveltejs/kit';
import { z } from 'zod';
import { parseClaims } from '$lib/auth/claims';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import { canonicalRoomName } from '$lib/model/room-name';
import { loadRoomState } from '$lib/server/room-state';
import { admits } from '$lib/model/stage';
import { stage } from '$lib/model/rules';

/**
 * Admit or decline a waiting guest (UX-ID-3, AR-CTRL-5).
 *
 * A control-plane route rather than a client write, for the same reason every
 * other write is one: clients hold no insert or update privilege on
 * `room_members`, so admission cannot be self-granted (AR-CTRL-7). The host
 * role is read server-side from the same membership row RLS consults, so a
 * request cannot claim it.
 *
 * Capacity is enforced HERE and not at join, which is what UX-STAGE-11 asks
 * for: "guests awaiting admission do not count against `max_participants` until
 * admitted". A room can therefore hold any number of hopefuls at the door and
 * still refuse the one that would overfill it.
 */
const body = z.object({
	guest: z.uuid(),
	decision: z.enum(['admit', 'decline'])
});

export const POST: RequestHandler = async ({ request, params, locals }) => {
	const claims = parseClaims(await locals.safeGetClaims());
	if (claims === null) error(401, 'Not signed in');

	const parsed = body.safeParse(await request.json());
	if (!parsed.success) error(400, 'Malformed request');

	const db = supabaseAdmin();
	const name = canonicalRoomName(params.room ?? '');
	const room = await db.from('rooms').select('id').eq('name', name).maybeSingle();
	if (room.data === null) error(404, 'No such room');

	const membership = await db
		.from('room_members')
		.select('role, status')
		.eq('room_id', room.data.id)
		.eq('identity_id', claims.sub)
		.maybeSingle();
	if (membership.data === null || membership.data.status !== 'admitted') {
		error(403, 'Not a member of this room');
	}
	if (membership.data.role !== 'host') error(403, 'Only a host can admit or decline');

	if (parsed.data.decision === 'admit') {
		const room_state = await loadRoomState(db, room.data.id);
		if (room_state === null) error(404, 'No such room');
		// The same rule the rule engine applies on arrival, read from the same
		// place, so the door and the canvas cannot disagree about "full".
		const present = Object.keys(room_state.state.participants).length;
		if (!admits(stage(room_state.state), present, false)) {
			error(409, 'This room is full');
		}
	}

	const next = parsed.data.decision === 'admit' ? 'admitted' : 'declined';
	const { error: failure, count } = await db
		.from('room_members')
		.update({ status: next, updated_at: new Date().toISOString() }, { count: 'exact' })
		.eq('room_id', room.data.id)
		.eq('identity_id', parsed.data.guest)
		// Only a PENDING guest is decided on. Without this, a second click could
		// silently demote an admitted participant, and a decline could be undone
		// by whoever clicked last.
		.eq('status', 'pending');
	if (failure !== null) throw new Error(failure.message);
	if (count === 0) error(409, 'That guest is no longer waiting');

	return json({ ok: true, status: next });
};
