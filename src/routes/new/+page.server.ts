import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { parseClaims, mayCreateRoom } from '$lib/auth/claims';

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
