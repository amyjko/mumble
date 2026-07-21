import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import type { PageServerLoad } from './$types';
import { canonicalRoomName, roomNameMessage, roomNameProblem } from '$lib/model/room-name';
import { parseClaims, mayCreateRoom } from '$lib/auth/claims';
import { defaultRoomState } from '$lib/model/presets';
import { freshRoomState } from '$lib/model/schemas';
import { diffRoomState } from '$lib/model/diff';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import { saveRoomState } from '$lib/server/room-state';

/**
 * The guard the landing page was built around (AR-AUTH-7, UX-ROOM-11).
 *
 * `/new` exists as its own route precisely so account creation has ONE place to
 * intercept. An anonymous session does not pass: a guest may join, edit, draw
 * and speak, but rooms belong to accounts (UX-ID-4). That asymmetry is real and
 * deliberate — see mayCreateRoom.
 *
 * A route guard, not a hook: a path-prefix check in hooks.server.ts silently
 * stops matching when a route moves, whereas this fails loudly and is directly
 * testable. It is also only half the gate — the other half is a RESTRICTIVE
 * RLS policy on `rooms` INSERT, which is what actually stops an anonymous
 * write. This half exists to give a good error instead of a database rejection.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const claims = parseClaims(await locals.safeGetClaims());
	if (!mayCreateRoom(claims)) redirect(303, '/login?next=/new');
	return {};
};

/**
 * Furnish the room that was just created (UX-ROOM-12).
 *
 * Service-role, and deliberately so: the room's objects, configurations and
 * placers are written through `save_room_state`, the same one-transaction path
 * every mutation takes (AR-BACKEND-4), which is not reachable from a caller's
 * client. The RLS gate that matters — may this identity make a room at all
 * (AR-AUTH-7) — has already run above, on the caller's own client, and is not
 * weakened by seeding what it admitted.
 *
 * No compare-and-swap: nothing can have raced a room that came into existence
 * microseconds ago.
 *
 * A failure here does NOT fail the creation. The room already exists and its
 * name is taken, so a 500 would leave someone with a room they cannot see and
 * cannot re-create by name; an unfurnished room is merely what every room was
 * before this function existed, and the host can build a layout by hand.
 */
async function seedRoom(roomId: string, ownerId: string): Promise<void> {
	try {
		const diff = diffRoomState(freshRoomState(), defaultRoomState(ownerId));
		await saveRoomState(supabaseAdmin(), roomId, null, diff);
	} catch (cause) {
		console.error(`could not seed default layouts for room ${roomId}`, cause);
	}
}

export const actions: Actions = {
	/**
	 * Create the room (AR-BACKEND-10, AR-CTRL-7).
	 *
	 * Uses the CALLER'S client, not a service-role one, so the RESTRICTIVE
	 * anonymous policy on `rooms` INSERT is a live production gate rather than
	 * dead code that only tests exercise. The load function above already
	 * refused an anonymous session — this is the half that actually stops the
	 * write, and it would stop it even if the guard were deleted.
	 *
	 * A trigger makes the creator the first host in the same transaction.
	 */
	default: async ({ request, locals }) => {
		const data = await request.formData();
		const raw = data.get('room');
		if (typeof raw !== 'string') return fail(400, { message: 'Pick a name.' });

		const name = canonicalRoomName(raw);
		const problem = roomNameProblem(name);
		if (problem !== null) return fail(400, { message: roomNameMessage(problem) });

		const claims = parseClaims(await locals.safeGetClaims());
		if (claims === null) redirect(303, '/login?next=/new');

		const { data: created, error } = await locals.supabase
			.from('rooms')
			.insert({ name, owner_id: claims.sub })
			.select('id')
			.single();
		if (error !== null) {
			// 23505 is unique_violation: the name is taken. Everything else is
			// reported as-is rather than guessed at.
			const message =
				error.code === '23505'
					? 'That name is taken.'
					: `Could not create the room: ${error.message}`;
			return fail(400, { message });
		}

		await seedRoom(created.id, claims.sub);
		redirect(303, `/${name}`);
	}
};
