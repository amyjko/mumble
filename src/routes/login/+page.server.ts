import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { parseClaims, mayCreateRoom } from '$lib/auth/claims';
import { enabledProviders } from '$lib/server/oauth-providers';
import { safeNext } from '../auth/confirm/confirm';
import { startOAuth } from './oauth';

/*
 * `safeNext` is imported rather than defined here.
 *
 * It existed in BOTH files, with the same open-redirect reasoning written out
 * twice — which is one copy that can drift, on the one rule where drifting
 * turns a sign-in page into a phishing tool. The confirm route's copy is the
 * one kept because that is where a link actually lands, and it is already unit
 * tested (`//evil.example` included, which a naive `startsWith('/')` misses).
 */

export const load: PageServerLoad = async ({ locals, url }) => {
	const claims = parseClaims(await locals.safeGetClaims());
	// Already signed in with a real account: nothing to do here.
	if (mayCreateRoom(claims)) redirect(303, safeNext(url.searchParams.get('next')));
	return {
		next: safeNext(url.searchParams.get('next')),
		// Empty locally, and that is the intended local experience rather than a
		// degraded one — see oauth-providers.ts.
		providers: enabledProviders()
	};
};

export const actions: Actions = {
	/**
	 * Magic link (UX-ID-7, AR-AUTH-4). A form action rather than a fetch, so it
	 * works before hydration — the sign-in page is the worst possible place to
	 * depend on JavaScript having loaded.
	 */
	magic: async ({ request, locals, url }) => {
		const data = await request.formData();
		const email = data.get('email');
		if (typeof email !== 'string' || !email.includes('@')) {
			return fail(400, { message: 'Enter an email address.' });
		}
		const next = safeNext(url.searchParams.get('next'));
		const { error } = await locals.supabase.auth.signInWithOtp({
			email,
			options: { emailRedirectTo: `${url.origin}/auth/confirm?next=${encodeURIComponent(next)}` }
		});
		if (error) return fail(400, { message: error.message });
		// Deliberately the same response whether or not the address has an
		// account: anything else turns this form into an account-existence
		// oracle.
		return { sent: true };
	},

	/**
	 * OAuth (UX-ID-7, AR-AUTH-4). A form action for the same reason `magic` is.
	 *
	 * It lands on the SAME `/auth/confirm` route with the same `next` contract,
	 * because the callback OAuth needs already existed: `confirmDestination`
	 * handles `?code=` through `exchangeCodeForSession`, which is what the magic
	 * link's real-email path turned out to need too. One callback, one place an
	 * open redirect could hide, one thing to test.
	 *
	 * The client must be `locals.supabase` — the SERVER client. `signInWithOAuth`
	 * sets the PKCE verifier cookie on this browser, and the exchange on the way
	 * back can only read it from there; confirm.ts already records that failure
	 * for the magic-link code path.
	 *
	 * Unlike `magic`, this leaks nothing about who has an account, so there is no
	 * oracle to suppress and no reason for a vague response.
	 */
	oauth: async ({ request, locals, url }) => {
		const data = await request.formData();
		const started = await startOAuth(
			url.origin,
			safeNext(url.searchParams.get('next')),
			data.get('provider'),
			locals.supabase.auth
		);
		if (!started.ok) return fail(400, { message: started.message });

		// The provider's consent screen. It is an absolute off-site URL, which is
		// the one case `safeNext` would refuse — correctly, since that guard is
		// about where WE send someone after signing in, not about the handshake.
		redirect(303, started.url);
	}
};
