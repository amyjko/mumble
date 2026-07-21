import { emailOtpTypeSchema } from '$lib/model/schemas';
import type { z } from 'zod';

/** The OTP types the confirm route accepts, from the one schema that lists them. */
type EmailOtpType = z.infer<typeof emailOtpTypeSchema>;

/**
 * Where a sign-in link should land, decided without touching SvelteKit or a
 * Supabase client (AR-TEST-4's idiom: keep the rule extractable from the thing
 * that wires it).
 *
 * Extracted for a concrete reason rather than tidiness. Type assertions are
 * banned in this project (`consistent-type-assertions: never`), so a unit test
 * cannot fake a whole `SupabaseClient` — and without this seam the only way to
 * cover the branches below would be an end-to-end test per branch, which is how
 * they ended up with no coverage at all.
 */

/** The two calls this route makes. Satisfied structurally by `supabase.auth`. */
export interface ConfirmAuth {
	exchangeCodeForSession(code: string): Promise<{ error: { message: string } | null }>;
	verifyOtp(params: {
		token_hash: string;
		type: EmailOtpType;
	}): Promise<{ error: { message: string } | null }>;
}

/** Where a failed or malformed link goes. One honest failure for every cause. */
export const SIGN_IN_FAILED = '/login?error=link';

/**
 * Only absolute PATHS are honoured.
 *
 * An open redirect would turn a sign-in link into a phishing tool: someone
 * lands on our domain, signs in for real, and is bounced elsewhere carrying the
 * impression that we sent them. `//evil.example` is the case worth naming — it
 * passes a naive `startsWith('/')` and a browser reads it as another HOST.
 */
export function safeNext(next: string | null): string {
	if (next === null || !next.startsWith('/') || next.startsWith('//')) return '/';
	return next;
}

/**
 * Resolve a confirm link to the path to redirect to.
 *
 * TWO shapes arrive here, and for a long time only one was handled — which
 * meant the one REAL users take was broken. Found 2026-07-20 by the first test
 * that ever read an actual email:
 *
 *  - `?code=…` — the PKCE authorization code, and what a link from a real email
 *    produces. The mail points at GoTrue's own `/auth/v1/verify`, which consumes
 *    the emailed token and 303s back here carrying a code. Exchanging it needs
 *    the verifier cookie `signInWithOtp` set on this browser, which is why the
 *    caller must pass a SERVER client rather than doing this in the browser.
 *  - `?token_hash=…&type=…` — the hash path, reachable by minting a link with
 *    the admin API. The whole E2E suite signs in this way because it needs no
 *    inbox, and that convenience is exactly what hid the missing branch: a
 *    hand-built URL never asks GoTrue to redirect anywhere, so nothing ever
 *    observed what a real link does.
 *
 * `code` is checked first because it is the path a person actually walks, and
 * because it is the fresher credential if a link somehow carries both. The same
 * exchange is what an OAuth callback needs, so this is the seam AR-TEST-8's
 * OAuth clause was pointing at.
 */
export async function confirmDestination(url: URL, auth: ConfirmAuth): Promise<string> {
	const destination = safeNext(url.searchParams.get('next'));

	const code = url.searchParams.get('code');
	if (code !== null) {
		const { error } = await auth.exchangeCodeForSession(code);
		return error === null ? destination : SIGN_IN_FAILED;
	}

	const tokenHash = url.searchParams.get('token_hash');
	const type = emailOtpTypeSchema.safeParse(url.searchParams.get('type'));
	if (tokenHash === null || !type.success) return SIGN_IN_FAILED;

	// A used, expired, or forged link all land here, and they are told apart
	// only by a message we would be guessing at.
	const { error } = await auth.verifyOtp({ token_hash: tokenHash, type: type.data });
	return error === null ? destination : SIGN_IN_FAILED;
}
