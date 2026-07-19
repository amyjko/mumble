import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';

/**
 * The control plane's write client (AR-SYNC-3, AR-CTRL-1).
 *
 * Holds the only write privilege on state tables — clients are granted SELECT
 * and nothing else, which is what makes "clients hold no write path" a fact
 * about privileges rather than a promise about code.
 *
 * `$env/dynamic/private` rather than static: the secret is read at RUNTIME from
 * the platform's store, so a build artifact never contains it (AR-DEPLOY-6).
 * Never import this from anything under src/lib that a component can reach —
 * SvelteKit's server-only guard catches it, but the rule matters more than the
 * guard.
 */
/**
 * Memoized per isolate, not per request.
 *
 * A fresh client per request means a fresh connection pool per request, and
 * the local stack ran out of connections part-way through an 85-test E2E run —
 * every later test failed with "Timed out acquiring connection from connection
 * pool", which reads like a broken feature and is a resource leak.
 */
let client: SupabaseClient<Database> | null = null;

export function supabaseAdmin(): SupabaseClient<Database> {
	if (client !== null) return client;
	const key = env['SUPABASE_SECRET_KEY'];
	if (key === '') {
		// Failing loudly here beats a confusing RLS denial three layers down.
		throw new Error('SUPABASE_SECRET_KEY is not set; the control plane cannot write.');
	}
	client = createClient<Database>(PUBLIC_SUPABASE_URL, key, {
		auth: { autoRefreshToken: false, persistSession: false }
	});
	return client;
}
