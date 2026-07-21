import { describe, expect, it } from 'vitest';
import { confirmDestination, safeNext, SIGN_IN_FAILED, type ConfirmAuth } from './confirm';

/**
 * The confirm handler's decision, in isolation (AR-TEST-8).
 *
 * This route had no unit test at all, which is how it shipped understanding
 * only half the links that reach it — the E2E suite signs in with a hand-built
 * token-hash URL, so the `?code=` branch a REAL email produces was never
 * exercised by anything, and magic-link sign-in was broken end to end.
 * `auth.e2e.ts` now covers that whole chain through the SMTP catcher; this file
 * covers the branches an E2E cannot reach cheaply: a failed exchange, a
 * malformed link, and the open-redirect guard.
 *
 * The guard deserves its own test rather than a reviewer's confidence. It is
 * one boolean expression standing between a sign-in link and a phishing tool,
 * and `//evil.example` passing `startsWith('/')` is the exact mistake it exists
 * to prevent — a browser reads that as another HOST, not a path.
 */

/** Records what the handler asked for, so order and pass-through are assertable. */
interface Seen {
	code?: string;
	hash?: string;
}

function auth(error: { message: string } | null, seen: Seen = {}): ConfirmAuth {
	return {
		exchangeCodeForSession(code) {
			seen.code = code;
			return Promise.resolve({ error });
		},
		verifyOtp(params) {
			seen.hash = params.token_hash;
			return Promise.resolve({ error });
		}
	};
}

const FAILED = { message: 'Email link is invalid or has expired' };

const destinationOf = async (
	query: string,
	error: { message: string } | null = null
): Promise<string> =>
	confirmDestination(new URL(`http://localhost/auth/confirm${query}`), auth(error));

describe('the PKCE code path (what a real email produces)', () => {
	it('exchanges the code and lands on `next`', async () => {
		expect(await destinationOf('?code=abc&next=%2Fnew')).toBe('/new');
	});

	it('passes the code through untouched', async () => {
		const seen: Seen = {};
		await confirmDestination(
			new URL('http://localhost/auth/confirm?code=abc-123'),
			auth(null, seen)
		);
		expect(seen.code).toBe('abc-123');
	});

	it('sends a failed exchange back to sign-in', async () => {
		expect(await destinationOf('?code=abc&next=%2Fnew', FAILED)).toBe(SIGN_IN_FAILED);
	});

	// Order matters: a link carrying both must not fall through to the hash
	// path, because the code is the fresher credential.
	it('prefers the code when a link somehow carries both', async () => {
		const seen: Seen = {};
		await confirmDestination(
			new URL('http://localhost/auth/confirm?code=abc&token_hash=xyz&type=magiclink'),
			auth(null, seen)
		);
		expect(seen.code).toBe('abc');
		expect(seen.hash).toBeUndefined();
	});
});

describe('the token-hash path (what the test suite mints)', () => {
	it('verifies and lands on `next`', async () => {
		expect(await destinationOf('?token_hash=xyz&type=magiclink&next=%2Fnew')).toBe('/new');
	});

	it('refuses a link carrying no credential at all', async () => {
		expect(await destinationOf('?next=%2Fnew')).toBe(SIGN_IN_FAILED);
	});

	it('refuses a type it does not recognise', async () => {
		expect(await destinationOf('?token_hash=xyz&type=nonsense')).toBe(SIGN_IN_FAILED);
	});

	it('sends a failed verification back to sign-in', async () => {
		expect(await destinationOf('?token_hash=xyz&type=magiclink', FAILED)).toBe(SIGN_IN_FAILED);
	});
});

describe('the open-redirect guard', () => {
	it('allows an ordinary path', async () => {
		expect(await destinationOf('?code=abc&next=%2Flci')).toBe('/lci');
	});

	// The one that matters: `//evil.example` starts with '/' and is NOT a path.
	it('refuses a protocol-relative URL', () => {
		expect(safeNext('//evil.example')).toBe('/');
	});

	it('refuses an absolute URL to another host', () => {
		expect(safeNext('https://evil.example')).toBe('/');
	});

	it('falls back to the root when `next` is absent', () => {
		expect(safeNext(null)).toBe('/');
	});

	// A failed sign-in must not honour `next` either, or a bad link would still
	// be a redirect primitive.
	it('does not honour `next` when the link fails', async () => {
		expect(await destinationOf('?code=abc&next=%2Fnew', FAILED)).toBe(SIGN_IN_FAILED);
	});
});
