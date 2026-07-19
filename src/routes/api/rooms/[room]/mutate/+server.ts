import { json, error, type RequestHandler } from '@sveltejs/kit';
import { mutationSchema } from '$lib/model/schemas';
import { StoreRejection } from '$lib/model/types';
import { applyMutation } from '$lib/model/rules';
import { diffRoomState } from '$lib/model/diff';
import { parseClaims } from '$lib/auth/claims';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import { loadRoomState, saveRoomState, VersionConflict } from '$lib/server/room-state';
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

	const ctx = { actorId: claims.sub, isHost: membership.data.role === 'host' };

	// Bounded retry on a version conflict. Bounded, not a loop: under a
	// concurrent drag an unbounded retry is a storm, and the loser seeing
	// UX-PERM-4's revert is a better outcome than the server grinding.
	for (let attempt = 0; attempt < 3; attempt++) {
		const room_state = await loadRoomState(db, room.data.id);
		if (room_state === null) error(404, 'No such room');

		// The engine mutates in place, so the "before" has to be captured now.
		// structuredClone rather than a JSON round trip: it preserves the shape
		// exactly, and the diff does a real recursive compare so it does not
		// care about key order either way.
		const before = structuredClone(room_state.state);

		try {
			applyMutation(room_state.state, parsed.data, ctx);
		} catch (rejection) {
			if (rejection instanceof StoreRejection) {
				// The same reasons the optimistic layer already reverts on, mapped
				// to status codes so the client can reconstruct them.
				const status = { permission: 403, overlap: 409, invalid: 400, forced: 409 }[rejection.reason];
				error(status, rejection.message);
			}
			throw rejection;
		}

		// Only what changed. Writing the whole room per mutation is what
		// exhausted the connection pool (see model/diff.ts).
		const diff = diffRoomState(before, room_state.state);
		if (diff.empty) return json({ ok: true, version: room_state.version });

		try {
			const version = await saveRoomState(db, room.data.id, room_state.version, diff);
			return json({ ok: true, version });
		} catch (conflict) {
			// Someone committed between our read and our write. Re-read and
			// re-apply, so the rule engine judges against the winner's state.
			if (!(conflict instanceof VersionConflict)) throw conflict;
		}
	}
	error(409, 'The room changed while you were writing. Try again.');
};
