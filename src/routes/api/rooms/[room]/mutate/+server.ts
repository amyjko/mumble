import { json, error, type RequestHandler } from '@sveltejs/kit';
import { mutationSchema } from '$lib/model/schemas';
import { StoreRejection } from '$lib/model/types';
import { applyMutation } from '$lib/model/rules';
import { diffRoomState } from '$lib/model/diff';
import { needsGuard, movesSomething } from '$lib/server/guard';
import { deleteImageBlobs, deleteImageBlobForRejectedCreate } from '$lib/server/image-cleanup';
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

	/*
	 * Bounded retry on a conflict. Bounded, not a loop: under a concurrent drag
	 * an unbounded retry is a storm, and the loser seeing UX-PERM-4's revert is
	 * a better outcome than the server grinding.
	 *
	 * Six, not three. Three predates the geometry guard, when the only conflicts
	 * were room-scalar writes that are rare by nature. Geometry writes now share
	 * a token deliberately (UX-OBJ-12), so the budget has to cover the number of
	 * people who might release a drag in the same instant. Measured: three
	 * concurrent movers all land inside six attempts; eight need about twelve,
	 * and eight simultaneous commits is already far past a real room, since a
	 * drag commits once on drop.
	 *
	 * Exhausting it is safe, which is what makes six a reasonable place to stop:
	 * the loser is REFUSED (409, a visible revert), not silently overlapped.
	 */
	for (let attempt = 0; attempt < 6; attempt++) {
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
				// A rejected image create already uploaded its bytes; remove the now
				// orphaned blob before returning the error (UX-OBJ-5). No-op otherwise,
				// and before error(), which throws.
				await deleteImageBlobForRejectedCreate(db, parsed.data);
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
			const version = await saveRoomState(
				db,
				room.data.id,
				needsGuard(diff, parsed.data.kind) ? room_state.version : null,
				diff,
				// Every object write is guarded by the version we READ for it, so
				// object conflicts are per object rather than per room. New objects
				// are simply absent from the map.
				room_state.objectVersions,
				// A header, not a body field: the body is the mutation union, and
				// which client sent it is transport, not vocabulary.
				request.headers.get('x-mumble-client'),
				// Geometry writes serialise with each other so two of them cannot
				// produce an overlap neither would be allowed alone (UX-OBJ-12).
				movesSomething(parsed.data.kind) ? room_state.geometryVersion : null
			);

			// An image's bytes live in Storage, not room state, so a deleted image
			// object would orphan its blob unless we remove it too (UX-OBJ-5). After
			// the row commit, from the PRE-mutation state (the diff carries only ids).
			await deleteImageBlobs(db, before, diff.objects.remove);
			return json({ ok: true, version });
		} catch (conflict) {
			// Someone committed between our read and our write. Re-read and
			// re-apply, so the rule engine judges against the winner's state.
			if (!(conflict instanceof VersionConflict)) throw conflict;
		}
	}
	error(409, 'The room changed while you were writing. Try again.');
};
