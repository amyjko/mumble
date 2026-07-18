import { createServerClient } from '@supabase/ssr';
import type { Handle } from '@sveltejs/kit';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY } from '$env/static/public';

/**
 * AR-AUTH-4: the Supabase server client is created per request and hangs off
 * `locals`. Cookie plumbing uses getAll/setAll — the older get/set/remove trio
 * is deprecated and breaks refresh-token rotation.
 *
 * AR-DEPLOY-1: this runs in workerd, not Node. Verified 2026-07-16 that
 * @supabase/ssr loads there under the scaffold's `nodejs_als` flag alone.
 */
export const handle: Handle = async ({ event, resolve }) => {
	event.locals.supabase = createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
		cookies: {
			getAll: () => event.cookies.getAll(),
			setAll: (cookiesToSet) => {
				for (const { name, value, options } of cookiesToSet) {
					event.cookies.set(name, value, { ...options, path: '/' });
				}
			}
		}
	});

	/**
	 * AR-AUTH-4 / STACK.md §7: prefer getClaims() over getUser(). getClaims()
	 * verifies the JWT locally against the JWKS; getUser() makes a network call
	 * on every request. getSession() is never trusted for authorization.
	 */
	event.locals.safeGetClaims = async () => {
		try {
			const { data, error } = await event.locals.supabase.auth.getClaims();
			if (error) return null;
			return data?.claims ?? null;
		} catch {
			// The DB being unreachable (local stack down, or a network blip) must not
			// crash the request. A getClaims() network failure rejects rather than
			// returning { error }, so it has to be caught here. Treat it as "no claims".
			return null;
		}
	};

	return resolve(event, {
		filterSerializedResponseHeaders: (name) => name === 'content-range' || name === 'x-supabase-api-version'
	});
};
