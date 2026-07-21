import { parseProvider } from '$lib/server/oauth-providers';

/**
 * Where an OAuth sign-in should send someone, decided without touching
 * SvelteKit or a Supabase client.
 *
 * Sibling of [confirm.ts](../auth/confirm/confirm.ts) and extracted for the
 * same concrete reason rather than tidiness: type assertions are banned in this
 * project (`consistent-type-assertions: never`), so a unit test cannot fake a
 * whole `SupabaseClient` or a whole `RequestEvent`. Without this seam the only
 * way to cover the branches below would be an end-to-end test per branch — and
 * for OAuth there is no such test available at all, because no mock provider
 * exists locally (AR-TEST-8). So this is not merely the convenient way to test
 * the decision; it is the only way.
 *
 * Together the two files are the whole round trip: this one decides where a
 * person is SENT, `confirm.ts` decides where they LAND. Both are pure, both are
 * node-tested, and the only untested link between them is the provider's own
 * consent screen, which is on AR-TEST-10's prod-only list.
 */

/** The one call this makes. Satisfied structurally by `supabase.auth`. */
export interface OAuthStart {
	signInWithOAuth(params: {
		provider: 'google';
		options: { redirectTo: string };
	}): Promise<{ data: { url: string | null }; error: { message: string } | null }>;
}

/** Either a provider URL to leave for, or something to tell the person. */
export type OAuthOutcome = { ok: true; url: string } | { ok: false; message: string };

/**
 * Refused when the requested provider is not offered by THIS deployment.
 *
 * Deliberately not "unknown provider": someone hand-posting a form does not
 * need to be told which names exist, and someone hitting it by accident is
 * better served by what they can do about it.
 */
export const UNAVAILABLE = 'That sign-in method is not available.';

/**
 * Begin a handshake for a submitted provider.
 *
 * `raw` is whatever the form carried, validated against the ENABLED providers
 * rather than the supported ones — hiding a button stops nobody, since the
 * action is a plain form post, so the enabled list has to be the boundary and
 * not just a rendering input.
 *
 * The callback is `/auth/confirm`, the same route and same `next` contract the
 * magic link uses, because the exchange OAuth needs already lived there. One
 * callback means one place an open redirect could hide, and `next` has already
 * been through `safeNext` by the time it arrives here.
 */
export async function startOAuth(
	origin: string,
	next: string,
	raw: unknown,
	auth: OAuthStart
): Promise<OAuthOutcome> {
	const provider = parseProvider(raw);
	if (provider === null) return { ok: false, message: UNAVAILABLE };

	const { data, error } = await auth.signInWithOAuth({
		provider: provider.id,
		options: { redirectTo: `${origin}/auth/confirm?next=${encodeURIComponent(next)}` }
	});

	// A null url with no error should not happen, and "should not happen" is how
	// `redirect(303, undefined)` gets shipped. Treated as the failure it is.
	if (error !== null || data.url === null) {
		return { ok: false, message: error?.message ?? UNAVAILABLE };
	}
	return { ok: true, url: data.url };
}
