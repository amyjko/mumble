import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which OAuth providers are offered (UX-ID-7).
 *
 * This is the half of OAuth that CAN be proven offline. AR-TEST-8 records why
 * the other half cannot: there is no mock provider in the Supabase CLI, so the
 * handshake itself is a prod-only truth (AR-TEST-10). What is testable is the
 * decision — which buttons exist, and which provider a form may ask for — and
 * that decision is the one carrying the security boundary, so it is the one
 * worth pinning.
 *
 * The environment is mocked rather than set, following ice.spec.ts: those types
 * come from whatever `.env` held at BUILD time, which is a different thing from
 * what the host hands the worker at runtime.
 */

const env: Record<string, string | undefined> = {};

vi.mock('$env/dynamic/private', () => ({ env }));

const { enabledProviders, parseProvider, selectProviders, SUPPORTED } = await import('./oauth-providers');

beforeEach(() => {
	env['OAUTH_PROVIDERS'] = undefined;
});

describe('the supported set', () => {
	it('names each provider once, with a label a person can read', () => {
		// One source of truth for id and copy, so a component never invents
		// either. If this grows a second row, nothing else should need to change.
		expect(SUPPORTED.map((p) => p.id)).toEqual(['google']);
		for (const provider of SUPPORTED) expect(provider.label).not.toBe('');
	});
});

describe('selecting from an allowlist', () => {
	it('offers nothing for an empty list', () => {
		expect(selectProviders('')).toEqual([]);
	});

	it('offers a named provider', () => {
		expect(selectProviders('google').map((p) => p.id)).toEqual(['google']);
	});

	it('ignores whitespace and case', () => {
		// Deploy environments are edited by hand, and ` Google ` is what a hand
		// produces. Being strict here buys nothing and costs a silent outage.
		expect(selectProviders(' Google ').map((p) => p.id)).toEqual(['google']);
	});

	it('drops an unknown name instead of throwing', () => {
		/*
		 * The failure mode this prevents: a typo in one variable taking down the
		 * whole sign-in page, which is the last route allowed to fail because it
		 * is where someone lands when something else already went wrong. One
		 * missing button is the honest, survivable outcome.
		 */
		expect(selectProviders('githbu').map((p) => p.id)).toEqual([]);
		expect(selectProviders('githbu,google').map((p) => p.id)).toEqual(['google']);
	});

	it('never invents a provider that is not supported', () => {
		// The list is an intersection, not a parse: naming something enables it
		// only if the code already knows how to offer it.
		expect(selectProviders('facebook,twitter,apple')).toEqual([]);
	});
});

describe('reading the environment', () => {
	it('offers nothing when unset — the local case', () => {
		// The whole "hide unconfigured providers" decision in one assertion: a
		// checkout that has never been deployed shows magic link and nothing else.
		expect(enabledProviders()).toEqual([]);
	});

	it('treats a blank value as absent', () => {
		/*
		 * Not hypothetical. `.env.example` ships names with EMPTY values so a
		 * deployer can see what to set, so every environment built from it has
		 * this variable present and blank. The TURN credentials were burned by
		 * exactly this reading — `ice.spec.ts` has the same test for the same
		 * reason, and that is a pattern worth repeating rather than rediscovering.
		 */
		env['OAUTH_PROVIDERS'] = '   ';
		expect(enabledProviders()).toEqual([]);
	});

	it('offers the provider when set', () => {
		env['OAUTH_PROVIDERS'] = 'google';
		expect(enabledProviders().map((p) => p.id)).toEqual(['google']);
	});
});

describe('validating a submitted provider', () => {
	it('accepts an enabled provider', () => {
		env['OAUTH_PROVIDERS'] = 'google';
		expect(parseProvider('google')?.id).toBe('google');
	});

	it('REFUSES a provider that is supported but not enabled', () => {
		/*
		 * The assertion this file exists for.
		 *
		 * Hiding a button is a rendering decision and stops nobody: the action is
		 * a plain form post, so anyone can send `provider=google` at a deployment
		 * that never configured it. Validating against the ENABLED list rather
		 * than the supported one is what makes the hidden button also an
		 * unreachable one — otherwise the list is decoration and the boundary is
		 * imaginary.
		 */
		expect(parseProvider('google')).toBeNull();
	});

	it('refuses an unknown name, a missing field, and a non-string', () => {
		env['OAUTH_PROVIDERS'] = 'google';
		expect(parseProvider('evil')).toBeNull();
		// What `FormData.get` returns for an absent field, and for a file upload:
		// both reach here, and neither is a provider.
		expect(parseProvider(null)).toBeNull();
		expect(parseProvider(new File([], 'x'))).toBeNull();
	});
});
