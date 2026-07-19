import { createClient } from '@supabase/supabase-js';
import type { Page } from '@playwright/test';

/**
 * Sign a browser in, offline (AR-TEST-8).
 *
 * "Magic link by generating the link server-side and verifying the token hash,
 * needing no email scraping." The admin API mints the link, we pull the token
 * hash out of it, and the browser visits our own confirm route — so the test
 * exercises the REAL callback rather than a fabricated cookie.
 *
 * The secret key never reaches the browser and never enters the repo; it comes
 * from the local stack's env (AR-DEPLOY-6).
 */
const url = process.env['PUBLIC_SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const secret = process.env['SUPABASE_SECRET_KEY'] ?? '';

/** A fresh address per call: reusing one trips Auth's rate limits mid-suite. */
export function testEmail(prefix = 'host'): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}@example.test`;
}

export async function signInAsAccount(page: Page, email = testEmail()): Promise<string> {
	const admin = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });

	// Create the user FIRST, confirmed. generateLink({type:'magiclink'}) on an
	// unknown address succeeds — it creates the user — but then issues a SIGNUP
	// token, which fails verification as a magiclink with the same opaque
	// "Email link is invalid or has expired" a forged link gives. Doing it in
	// two steps means this exercises the genuine magic-link path (AR-TEST-8)
	// rather than a signup confirmation wearing its name.
	await admin.auth.admin.createUser({ email, email_confirm: true });

	const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
	if (error !== null) {
		// A missing or blank secret key surfaces here as something unhelpful, so
		// say what it actually means.
		throw new Error(`generateLink failed (is SUPABASE_SECRET_KEY set?): ${error.message}`);
	}

	const tokenHash = data.properties.hashed_token;
	await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=magiclink&next=/`);
	// generateLink always returns a user on success; the types say so.
	return data.user.id;
}
