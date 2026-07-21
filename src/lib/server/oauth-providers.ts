import { env } from '$env/dynamic/private';

/**
 * Which OAuth providers this deployment offers (UX-ID-7, AR-AUTH-4).
 *
 * Sibling of [ice.ts](./ice.ts) in shape and for the same reason: a runtime
 * decision that depends on the environment, kept pure enough to unit-test, and
 * reading `$env/dynamic/private` rather than the static env because the value
 * comes from the host's secret store at RUNTIME rather than from a build-time
 * `.env` (AR-DEPLOY-5, AR-DEPLOY-6).
 *
 * **Why a list at all, rather than always showing the buttons.** There is no
 * mock OAuth provider in the Supabase CLI — AR-TEST-8 states that as the reason
 * OAuth is not tested locally — so a button that always renders is dead in
 * every development environment, and the only thing clicking it produces is
 * "Unsupported provider". Rendering from a list makes the local truth (magic
 * link only) and the production truth (magic link plus a provider) the same
 * code path with different data, and makes the decision a thing a node test can
 * hold, which is the half of this feature that CAN be proven offline.
 *
 * Note for whoever adds the second provider: nothing here is Google-specific
 * except one row of `SUPPORTED`. The id is what Supabase Auth calls the
 * provider and the label is what a person reads, and neither belongs in a
 * component.
 */

/** A provider a person can be offered. `id` is Supabase's name for it. */
export interface OAuthProvider {
	/**
	 * Kept a literal union rather than `string` so it is assignable to the auth
	 * client's own provider type without a cast — type assertions are banned
	 * here (`consistent-type-assertions: never`), so the types have to line up
	 * by construction rather than by force.
	 */
	readonly id: 'google';
	readonly label: string;
}

/**
 * Every provider the code knows how to offer. Being here does not enable it —
 * `enabledProviders` does, from the environment.
 *
 * Google rather than GitHub: the people this product is for are small groups
 * meeting for work or school, and that is the account they already have. A
 * developer-facing provider would be the narrower choice wearing the more
 * familiar name.
 */
export const SUPPORTED: readonly OAuthProvider[] = [{ id: 'google', label: 'Continue with Google' }];

/**
 * Resolve a comma-separated allowlist to providers, dropping what is unknown.
 *
 * Pure, so the whole decision is node-testable per AR-TEST-4 without mocking an
 * environment. Exported for that test; callers want `enabledProviders`.
 *
 * **An unknown name is dropped, never thrown on.** A typo in a deploy
 * environment should cost one missing button, not the entire sign-in page —
 * this is the last route that may fail, because it is the one a person reaches
 * when something else already went wrong. Same instinct as `iceServers`
 * returning STUN rather than refusing when TURN is misconfigured.
 */
export function selectProviders(raw: string): readonly OAuthProvider[] {
	const named = new Set(
		raw
			.split(',')
			.map((name) => name.trim().toLowerCase())
			.filter((name) => name !== '')
	);
	return SUPPORTED.filter((provider) => named.has(provider.id));
}

/**
 * The providers this deployment offers. Empty locally, which is correct.
 *
 * Gated on ONE variable rather than on the presence of a client id, because the
 * client id and secret live in the Supabase project's own auth configuration
 * and never reach this worker — there is nothing here to sniff for. So the
 * allowlist is the deployer's explicit statement that the provider is wired at
 * the other end, and it is the only thing that could be.
 */
export function enabledProviders(): readonly OAuthProvider[] {
	// `unknown` for the reason ice.ts and media-key.ts both record: the generated
	// types describe a build-time .env, not the platform's runtime secret store.
	const raw: unknown = env['OAUTH_PROVIDERS'];
	// A blank value reads as "none", and this is not hypothetical: `.env.example`
	// ships every name with an empty value so deployers can see what to set, so
	// every environment built from it has this variable present and blank. The
	// TURN credentials were burned by exactly this and their test says so.
	return typeof raw === 'string' ? selectProviders(raw) : [];
}

/**
 * The provider a submitted form is asking for, or `null`.
 *
 * Validated against what is ENABLED rather than against what is supported, so a
 * hand-posted form cannot open a handshake with a provider this deployment does
 * not offer. That distinction is the whole reason this function exists instead
 * of a `find` at the call site: the enabled list is a security boundary as well
 * as a rendering input, and the two must not drift apart.
 */
export function parseProvider(raw: unknown): OAuthProvider | null {
	if (typeof raw !== 'string') return null;
	return enabledProviders().find((provider) => provider.id === raw) ?? null;
}
