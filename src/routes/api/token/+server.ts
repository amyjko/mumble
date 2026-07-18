import { json, type RequestHandler } from '@sveltejs/kit';

/**
 * A stand-in for the real token endpoint (AR-CTRL-1). It exists now only to
 * pull @supabase/supabase-js into the worker bundle so AR-DEPLOY-3's size
 * check measures something real, and so the offline test has a route that
 * touches the database.
 */
export const POST: RequestHandler = async ({ locals }) => {
	const claims = await locals.safeGetClaims();
	const { error } = await locals.supabase.from('_healthcheck').select('*').limit(1);
	return json({
		ok: true,
		runtime: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
		anonymous: claims?.is_anonymous ?? null,
		db: error ? `unreachable: ${error.message}` : 'reachable'
	});
};
