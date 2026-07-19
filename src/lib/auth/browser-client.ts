import { createBrowserClient } from '@supabase/ssr';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY } from '$env/static/public';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';

/**
 * The browser's Supabase client.
 *
 * One instance per tab, not per component: `createBrowserClient` installs
 * storage and refresh listeners, and a second instance means two schedulers
 * fighting over the same refresh token — which surfaces as random sign-outs
 * that reproduce only under load.
 */
let client: SupabaseClient<Database> | null = null;

export function supabaseBrowser(): SupabaseClient<Database> {
	client ??= createBrowserClient<Database>(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
		cookies: {
			// Explicit getAll/setAll, matching hooks.server.ts. The implicit
			// form is deprecated for the same reason the old get/set/remove
			// trio was: it cannot express multiple cookies atomically, which
			// breaks refresh-token rotation.
			getAll: () =>
				document.cookie
					.split('; ')
					.filter((pair) => pair !== '')
					.map((pair) => {
						const eq = pair.indexOf('=');
						return {
							name: decodeURIComponent(pair.slice(0, eq)),
							value: decodeURIComponent(pair.slice(eq + 1))
						};
					}),
			setAll: (cookies) => {
				for (const { name, value, options } of cookies) {
					const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`, 'path=/'];
					if (options.maxAge !== undefined) parts.push(`max-age=${String(options.maxAge)}`);
					if (options.sameSite !== undefined) parts.push(`samesite=${String(options.sameSite)}`);
					// Secure only over HTTPS: setting it on http://localhost makes
					// the browser silently drop the cookie, i.e. sign-in appears to
					// succeed and no session ever exists.
					if (location.protocol === 'https:') parts.push('secure');
					document.cookie = parts.join('; ');
				}
			}
		}
	});
	return client;
}

/**
 * Ensure a session exists, signing in anonymously if not (AR-AUTH-1).
 *
 * "Anonymous guests use signInAnonymously() — so `creator_id` = the auth user
 * id for guests and account holders alike, ONE code path." That is the whole
 * point: no branch anywhere downstream asks whether you have an account, and
 * the id the server trusts is the one it verified, not one the browser minted.
 *
 * Returns the user id, which replaces the localStorage UUID that anyone could
 * edit to impersonate anyone.
 */
export async function ensureSession(): Promise<string | null> {
	const supabase = supabaseBrowser();
	const { data: existing } = await supabase.auth.getSession();
	if (existing.session !== null) return existing.session.user.id;

	const { data, error } = await supabase.auth.signInAnonymously();
	// A failure here is not fatal to the page: the room still renders, and the
	// join prompt will report that it cannot proceed. Throwing would blank the
	// canvas over a transient network problem.
	if (error !== null) return null;
	return data.user?.id ?? null;
}
