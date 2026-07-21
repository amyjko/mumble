import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthStart } from './oauth';

/**
 * Starting an OAuth handshake (UX-ID-7, AR-AUTH-4).
 *
 * The outbound half of the round trip; `auth/confirm/server.spec.ts` covers the
 * inbound half. Between them the only untested step is the provider's own
 * consent screen, which no local environment can produce (AR-TEST-8) and which
 * AR-TEST-10 therefore carries as a prod-only truth.
 *
 * The environment is mocked because the enabled-provider list is read from it,
 * and the enabled list is what decides whether a submitted provider is honoured
 * at all.
 */

const env: Record<string, string | undefined> = {};

vi.mock('$env/dynamic/private', () => ({ env }));

const { startOAuth, UNAVAILABLE } = await import('./oauth');

beforeEach(() => {
	env['OAUTH_PROVIDERS'] = 'google';
});

/** A provider that always agrees, recording what it was asked. */
function willing(url = 'https://accounts.example/authorize?x=1'): {
	auth: OAuthStart;
	calls: { provider: string; redirectTo: string }[];
} {
	const calls: { provider: string; redirectTo: string }[] = [];
	return {
		calls,
		auth: {
			signInWithOAuth(params) {
				calls.push({ provider: params.provider, redirectTo: params.options.redirectTo });
				return Promise.resolve({ data: { url }, error: null });
			}
		}
	};
}

/** One that refuses, the way a misconfigured project does. */
const refusing: OAuthStart = {
	signInWithOAuth() {
		return Promise.resolve({ data: { url: null }, error: { message: 'Unsupported provider' } });
	}
};

describe('starting a handshake', () => {
	it('returns the provider URL to leave for', async () => {
		const { auth } = willing();
		const outcome = await startOAuth('https://mumble.studio', '/', 'google', auth);
		expect(outcome).toEqual({ ok: true, url: 'https://accounts.example/authorize?x=1' });
	});

	it('asks for the submitted provider, landing on the shared callback', async () => {
		const { auth, calls } = willing();
		await startOAuth('https://mumble.studio', '/standup', 'google', auth);
		expect(calls).toEqual([
			{
				provider: 'google',
				// The SAME route the magic link uses, because the `?code=` exchange
				// OAuth needs already lived there. One callback, one place an open
				// redirect could hide.
				redirectTo: 'https://mumble.studio/auth/confirm?next=%2Fstandup'
			}
		]);
	});

	it('encodes a destination that contains a query of its own', async () => {
		// Unencoded, everything after the first `&` would be read as OUR parameter
		// rather than part of `next`, and someone would land in the wrong place.
		const { auth, calls } = willing();
		await startOAuth('https://mumble.studio', '/a?b=1&c=2', 'google', auth);
		expect(calls[0]?.redirectTo).toBe(
			'https://mumble.studio/auth/confirm?next=%2Fa%3Fb%3D1%26c%3D2'
		);
	});
});

describe('a provider this deployment does not offer', () => {
	it('is refused even though it is supported by the code', async () => {
		/*
		 * The assertion this file exists for, and the reason the enabled list is a
		 * boundary rather than a rendering input. Hiding the button stops nobody:
		 * the action is a plain form post, so `provider=google` can be sent to a
		 * deployment that never configured it. It must be refused BEFORE any
		 * handshake is attempted — hence the untouched `calls`.
		 */
		env['OAUTH_PROVIDERS'] = '';
		const { auth, calls } = willing();
		const outcome = await startOAuth('https://mumble.studio', '/', 'google', auth);
		expect(outcome).toEqual({ ok: false, message: UNAVAILABLE });
		expect(calls).toEqual([]);
	});

	it('refuses an unknown name and a missing field without calling out', async () => {
		const { auth, calls } = willing();
		expect(await startOAuth('https://mumble.studio', '/', 'evil', auth)).toEqual({
			ok: false,
			message: UNAVAILABLE
		});
		// What `FormData.get` returns when the field is absent entirely.
		expect(await startOAuth('https://mumble.studio', '/', null, auth)).toEqual({
			ok: false,
			message: UNAVAILABLE
		});
		expect(calls).toEqual([]);
	});
});

describe('when the provider refuses', () => {
	it('surfaces the message rather than redirecting', async () => {
		const outcome = await startOAuth('https://mumble.studio', '/', 'google', refusing);
		expect(outcome).toEqual({ ok: false, message: 'Unsupported provider' });
	});

	it('treats a URL-less success as a failure', async () => {
		/*
		 * Should not happen, and "should not happen" is how `redirect(303,
		 * undefined)` gets shipped — which fails as a 500 on the sign-in page,
		 * the one route that has to keep working when something else is broken.
		 */
		const silent: OAuthStart = {
			signInWithOAuth: () => Promise.resolve({ data: { url: null }, error: null })
		};
		expect(await startOAuth('https://mumble.studio', '/', 'google', silent)).toEqual({
			ok: false,
			message: UNAVAILABLE
		});
	});
});
