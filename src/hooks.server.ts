import { createServerClient } from '@supabase/ssr';
import type { Handle } from '@sveltejs/kit';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY } from '$env/static/public';
import type { Database } from '$lib/database.types';

/**
 * AR-AUTH-4: the Supabase server client is created per request and hangs off
 * `locals`. Cookie plumbing uses getAll/setAll — the older get/set/remove trio
 * is deprecated and breaks refresh-token rotation.
 *
 * AR-BACKEND-9: the client is typed against the generated Database type
 * (`pnpm gen:db` regenerates it from the local schema).
 *
 * AR-DEPLOY-1: this runs in workerd, not Node. Verified 2026-07-16 that
 * @supabase/ssr loads there under the scaffold's `nodejs_als` flag alone.
 */
export const handle: Handle = async ({ event, resolve }) => {
	event.locals.supabase = createServerClient<Database>(
		PUBLIC_SUPABASE_URL,
		PUBLIC_SUPABASE_PUBLISHABLE_KEY,
		{
			cookies: {
				getAll: () => event.cookies.getAll(),
				setAll: (cookiesToSet) => {
					for (const { name, value, options } of cookiesToSet) {
						try {
							event.cookies.set(name, value, { ...options, path: '/' });
						} catch {
							// GoTrue can finish a detached token refresh AFTER the response
							// has been sent; SvelteKit then throws on cookies.set, and in a
							// detached chain that's an uncaught rejection that kills the
							// process. Drop the late write. Recovery is guaranteed by the
							// eager in-request safeGetClaims() below, which lands auth
							// cookie updates while writes are still allowed.
						}
					}
				}
			}
		}
	);

	/**
	 * AR-AUTH-4 / STACK.md §7: prefer getClaims() over getUser(). getClaims()
	 * verifies the JWT signature locally against the JWKS; getUser() makes a
	 * network call on every request. getSession() is never trusted for authz.
	 * Memoized per request so the eager call below and any route share one result.
	 */
	let claims: Promise<Record<string, unknown> | null> | null = null;
	event.locals.safeGetClaims = () => {
		claims ??= (async () => {
			try {
				const { data, error } = await event.locals.supabase.auth.getClaims();
				if (error) return null;
				return data?.claims ?? null;
			} catch {
				// The stack being unreachable (local Supabase down, or a network blip)
				// must not crash the request. A getClaims() network failure rejects
				// rather than returning { error }; treat it as "no claims".
				return null;
			}
		})();
		return claims;
	};

	/**
	 * When an auth cookie exists, resolve the session NOW, inside the request.
	 * Otherwise GoTrue's refresh runs detached and finishes after the response,
	 * where its cookie writes (including clearing a DEAD refresh token) are
	 * dropped by the guard above — so a stale cookie would be retried on every
	 * request forever. Awaiting here lands the refresh — or the sign-out that
	 * clears the bad cookie — while cookie writes are still allowed. Requests
	 * without auth cookies (the whole anonymous canvas path) skip this and pay
	 * nothing.
	 */
	if (event.cookies.getAll().some(({ name }) => name.startsWith('sb-'))) {
		await event.locals.safeGetClaims();
	}

	return resolve(event, {
		filterSerializedResponseHeaders: (name) => name === 'content-range' || name === 'x-supabase-api-version'
	});
};
