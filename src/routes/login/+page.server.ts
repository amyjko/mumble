import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { parseClaims, mayCreateRoom } from '$lib/auth/claims';

/** Where to return after signing in. Only same-site paths, never a full URL. */
function safeNext(raw: string | null): string {
	// An open redirect is the classic way a login page becomes a phishing tool:
	// `?next=https://evil.example` would send someone off-site carrying the
	// impression that we sent them. Only absolute PATHS are accepted.
	if (raw === null || !raw.startsWith('/') || raw.startsWith('//')) return '/';
	return raw;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const claims = parseClaims(await locals.safeGetClaims());
	// Already signed in with a real account: nothing to do here.
	if (mayCreateRoom(claims)) redirect(303, safeNext(url.searchParams.get('next')));
	return { next: safeNext(url.searchParams.get('next')) };
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
	}
};
