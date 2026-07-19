import { createClient } from '@supabase/supabase-js';

/**
 * Fail fast, and legibly, when the local stack cannot serve.
 *
 * This exists because an exhausted connection pool masqueraded as broken
 * application code twice in one night. Every request fails with "Timed out
 * acquiring connection from connection pool", so 60+ tests go red at once and
 * the output looks like a catastrophic regression. Worse, an exhausted pool
 * POISONS later runs: two full-suite results were read as verdicts on a code
 * change when they were verdicts on the environment.
 *
 * One query before the suite starts turns four minutes of confusion into one
 * line. It deliberately does NOT try to fix anything — restarting Supabase is
 * the user's call, not a test harness's.
 */
export default async function globalSetup(): Promise<void> {
	const url = process.env['PUBLIC_SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
	const secret = process.env['SUPABASE_SECRET_KEY'] ?? '';
	if (secret === '') {
		throw new Error(
			'E2E needs SUPABASE_SECRET_KEY in .env.\n' +
				'  supabase status -o env | grep SECRET_KEY'
		);
	}

	const admin = createClient(url, secret, { auth: { persistSession: false } });
	const { error } = await admin.from('rooms').select('id').limit(1);
	if (error === null) return;

	// The two failures worth naming, because their messages are unhelpful and
	// their fixes are different.
	if (error.message.includes('connection pool')) {
		throw new Error(
			`Supabase connection pool is exhausted — the stack needs a restart.\n` +
				`  pnpm supabase:stop && pnpm supabase:start && pnpm supabase:reset\n\n` +
				`Every test would fail with "Timed out acquiring connection from connection ` +
				`pool", which looks like a broken app and is not. A previous run leaked ` +
				`connections; results from this run would be measuring the environment.`
		);
	}
	if (error.code === 'PGRST002') {
		throw new Error(
			`PostgREST cannot load the schema cache (PGRST002) — the stack is unhealthy.\n` +
				`  pnpm supabase:stop && pnpm supabase:start && pnpm supabase:reset`
		);
	}
	// Everything else, including a stack that is simply not running ("fetch
	// failed"). Verified 2026-07-19 by stopping Supabase mid-session.
	throw new Error(
		`Supabase is not answering: ${error.message}\n` +
			`  pnpm supabase:start && pnpm supabase:reset`
	);
}
