import { json, error, type RequestHandler } from '@sveltejs/kit';
import { mutationSchema } from '$lib/model/schemas';
import { StoreRejection } from '$lib/model/types';
import { applyMutation } from '$lib/model/rules';
import { parseClaims } from '$lib/auth/claims';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import { loadRoomState, saveRoomState } from '$lib/server/room-state';
import { canonicalRoomName } from '$lib/model/room-name';

/**
 * The ONLY write path (AR-SYNC-3, AR-CTRL-1).
 *
 * One endpoint taking the mutation union, not forty routes. The union IS the
 * seam's vocabulary and the store interface is literally `commit(mutation)`;
 * forty routes would be forty copies of this preamble, and the preamble is
 * where the security lives. It also means an unhandled mutation kind is a
 * compile error rather than a missing file.
 *
 * The actor comes from the VERIFIED JWT, never the body. That is the whole
 * point: `requireSelf` and every `creator_id` check were decorative while the
 * id was a string the browser chose.
 */
export const POST: RequestHandler = async ({ request, params, locals }) => {
	const claims = parseClaims(await locals.safeGetClaims());
	if (claims === null) error(401, 'Not signed in');

	const parsed = mutationSchema.safeParse(await request.json());
	if (!parsed.success) error(400, 'Malformed mutation');

	const db = supabaseAdmin();
	const name = canonicalRoomName(params.room ?? '');

	const room = await db.from('rooms').select('id').eq('name', name).maybeSingle();
	if (room.data === null) error(404, 'No such room');

	// Membership decides BOTH whether you may act and whether you are a host.
	// Read server-side from the same row the RLS policies consult, so the
	// client cannot claim a role it does not hold.
	const membership = await db
		.from('room_members')
		.select('role, status')
		.eq('room_id', room.data.id)
		.eq('identity_id', claims.sub)
		.maybeSingle();
	if (membership.data === null || membership.data.status !== 'admitted') {
		error(403, 'Not a member of this room');
	}

	const state = await loadRoomState(db, room.data.id);
	if (state === null) error(404, 'No such room');

	try {
		applyMutation(state, parsed.data, {
			actorId: claims.sub,
			isHost: membership.data.role === 'host'
		});
	} catch (rejection) {
		if (rejection instanceof StoreRejection) {
			// The same reasons the optimistic layer already reverts on, mapped to
			// status codes so the client can reconstruct them.
			const status = { permission: 403, overlap: 409, invalid: 400, forced: 409 }[rejection.reason];
			error(status, rejection.message);
		}
		throw rejection;
	}

	await saveRoomState(db, room.data.id, state);
	return json({ ok: true });
};
