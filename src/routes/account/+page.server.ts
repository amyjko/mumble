import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { parseClaims } from '$lib/auth/claims';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import { accountBudget } from '$lib/server/ledger';

/**
 * The account page (UX-ID-10, UX-ECON-2).
 *
 * It exists because the weekly budget had nowhere to be seen except from inside
 * a room, which is precisely too late: the number decides which meetings a host
 * can still run this week, and they could only read it after committing to one.
 *
 * The budget is read HERE rather than in the browser, and not for secrecy — a
 * client may already read its own `accounts` row (`accounts_select_own`). It is
 * because the weekly reset is LAZY (AR-COST-6): `roll_account` is service-role
 * only, so a direct client read would show last week's total to anyone whose
 * week had turned, and this page would be the one place in the product still
 * reporting a budget as spent after it had reset.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const claims = parseClaims(await locals.safeGetClaims());
	if (claims === null) redirect(303, '/login?next=%2Faccount');

	/*
	 * A guest gets the page, not a redirect.
	 *
	 * They have a real account row like everyone else (AR-AUTH-6: the boundary
	 * is that the identity is browser-bound, not that the storage differs), and
	 * a budget that is always full because an anonymous identity cannot own a
	 * room to spend it (AR-AUTH-7). Showing them "10h left" would be true and
	 * meaningless, so the page says what their situation actually is instead.
	 */
	if (claims.is_anonymous) {
		return { anonymous: true, email: null, budget: null };
	}

	const budget = await accountBudget(supabaseAdmin(), claims.sub);
	return {
		anonymous: false,
		// From the VERIFIED token, not from a profile row: this is the address
		// the account signs in with, and it is the one thing on this page that
		// must not come from anywhere a client could have written.
		email: claims.email ?? null,
		budget
	};
};

export const actions: Actions = {
	/**
	 * Change the sign-in address (UX-ID-10).
	 *
	 * A form action rather than a fetch, matching the login page: this is
	 * identity plumbing, and it should not stop working because a bundle failed
	 * to load.
	 *
	 * `updateUser` does NOT change the address — it sends confirmations, which
	 * is why the success message promises a link rather than an outcome, and why
	 * the page still shows the old address after a successful submit.
	 *
	 * HOW MANY confirmations are needed was got wrong here first, and the
	 * correction is worth keeping. `double_confirm_changes = true` reads as
	 * "both inboxes must agree", so the copy said so; an E2E test that followed
	 * only ONE link found the change completing anyway. Both addresses are
	 * mailed — the current one is always told — but a single confirmation
	 * finishes it, because `enable_confirmations = false` auto-confirms the
	 * second side. See the note in supabase/config.toml, and the open item in
	 * DESIGN.md about whether that should change.
	 *
	 * The security consequence, stated plainly: someone with a live session can
	 * move the account to their own address, and the original owner is NOTIFIED
	 * but cannot veto it.
	 */
	changeEmail: async ({ request, locals, url }) => {
		const claims = parseClaims(await locals.safeGetClaims());
		if (claims === null) redirect(303, '/login?next=%2Faccount');
		// An anonymous identity has no address to change, and setting one is the
		// guest-upgrade ladder (UX-ID-8), which is V2 and deliberately unbuilt —
		// doing it accidentally here would ship half of it with none of its
		// "carries everything over" guarantees.
		if (claims.is_anonymous) return fail(403, { message: 'Guests have no sign-in address yet.' });

		const data = await request.formData();
		const email = data.get('email');
		if (typeof email !== 'string' || !email.includes('@')) {
			return fail(400, { message: 'Enter an email address.' });
		}
		if (email === claims.email) {
			return fail(400, { message: 'That is already your address.' });
		}

		const { error } = await locals.supabase.auth.updateUser(
			{ email },
			{ emailRedirectTo: `${url.origin}/auth/confirm?next=%2Faccount` }
		);
		// Surfaced as given. Unlike sign-in, this is not an account-existence
		// oracle worth guarding: the caller is already authenticated, and
		// "address already in use" is something they need to be told.
		if (error) return fail(400, { message: error.message });

		return { sent: true, address: email };
	}
};
