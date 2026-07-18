import { json, type RequestHandler } from '@sveltejs/kit';

/**
 * A stand-in for the real token endpoint (AR-CTRL-1). It exists now to pull the
 * Supabase client into the worker bundle (so AR-DEPLOY-3 measures something
 * real) and to give the offline test a route that touches the local stack.
 * The auth probe suffices for reachability; a DB query returns when a schema
 * exists (AR-BACKEND-9 generated types make an untyped query a compile error,
 * which is the norms working as intended).
 */
export const POST: RequestHandler = async ({ locals }) => {
	const claims = await locals.safeGetClaims();
	return json({
		ok: true,
		runtime: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
		anonymous: claims?.['is_anonymous'] ?? null,
		auth: claims === null ? 'no session (or stack unreachable)' : 'claims verified'
	});
};
