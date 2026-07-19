import type { LayoutServerLoad } from './$types';
import { parseClaims } from '$lib/auth/claims';

/**
 * The session's single entry point into the page tree (AR-AUTH-4).
 *
 * `hooks.server.ts` verifies the JWT locally on every request; this is where
 * the result becomes something pages can read. Nothing else calls
 * `safeGetClaims` in a load — one source, parsed once.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
	return { claims: parseClaims(await locals.safeGetClaims()) };
};
