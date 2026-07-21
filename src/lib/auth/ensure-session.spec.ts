import { describe, expect, it, vi } from 'vitest';

/**
 * `ensureSession` must mint at most ONE anonymous user per browser (UX-ID-5,
 * AR-AUTH-1).
 *
 * This exists because it did not. The function was a check-then-act —
 * `getSession()`, and if null, `signInAnonymously()` — and the room page calls
 * it twice by design (once on mount for the roaming profile, once when the join
 * prompt supplies a hello). Under load the two overlapped, both saw no session,
 * and both signed in, so one browser became two anonymous identities.
 *
 * The visible damage was at an "ask first" door: the host saw the same arrival
 * twice, once as a nameless "Someone" that could never be matched to a person,
 * and that phantom row stayed pending forever. It was found from a flaky E2E
 * and confirmed in the database — two `room_members` rows, two anonymous users,
 * 62ms apart — which is why the assertion here is a COUNT of sign-ins rather
 * than anything about the returned id.
 *
 * `$env/static/public` is mocked because importing the module pulls in the real
 * browser client, which reads build-time env and `document.cookie`; neither is
 * relevant to the question this file asks.
 */

vi.mock('$env/static/public', () => ({
	PUBLIC_SUPABASE_URL: 'http://localhost:54321',
	PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-key'
}));

const { ensureSession } = await import('./browser-client');

/** Only the two auth calls `ensureSession` makes. */
function fakeAuth(options: { session: { user: { id: string } } | null; signInMs?: number }) {
	let signIns = 0;
	let issued = 0;
	const client = {
		auth: {
			getSession() {
				return Promise.resolve({ data: { session: options.session }, error: null });
			},
			async signInAnonymously() {
				signIns += 1;
				issued += 1;
				const id = `anon-${String(issued)}`;
				// A real sign-in is a network round trip; the race only exists
				// because it takes time, so the double must take time too.
				await new Promise((resolve) => setTimeout(resolve, options.signInMs ?? 10));
				options.session = { user: { id } };
				return { data: { user: { id } }, error: null };
			}
		}
	};
	return { client, signIns: () => signIns };
}

describe('ensureSession', () => {
	it('signs in exactly once when called concurrently', async () => {
		const { client, signIns } = fakeAuth({ session: null });

		// Five overlapping callers — the room page needs only two to break it.
		const ids = await Promise.all([
			ensureSession(client),
			ensureSession(client),
			ensureSession(client),
			ensureSession(client),
			ensureSession(client)
		]);

		expect(signIns()).toBe(1);
		// ...and every caller gets the SAME identity, which is the property the
		// callers actually depend on: two knocks must be one person.
		expect(new Set(ids).size).toBe(1);
		expect(ids[0]).toBe('anon-1');
	});

	it('does not sign in again once a session exists', async () => {
		const { client, signIns } = fakeAuth({ session: { user: { id: 'existing' } } });
		expect(await ensureSession(client)).toBe('existing');
		expect(await ensureSession(client)).toBe('existing');
		expect(signIns()).toBe(0);
	});

	/**
	 * The memo must not outlive the sign-in it was covering, or a later caller
	 * would be answered from a stale promise instead of reading the session
	 * that now exists — including after a sign-out.
	 */
	it('re-checks the session on a later, separate call', async () => {
		const options: { session: { user: { id: string } } | null } = { session: null };
		const { client, signIns } = fakeAuth(options);

		expect(await ensureSession(client)).toBe('anon-1');
		expect(signIns()).toBe(1);

		// A second call, well after the first settled, finds the session the
		// first one established and mints nothing.
		expect(await ensureSession(client)).toBe('anon-1');
		expect(signIns()).toBe(1);
	});

	it('reports failure as null rather than throwing', async () => {
		const client = {
			auth: {
				getSession: () => Promise.resolve({ data: { session: null }, error: null }),
				signInAnonymously: () =>
					Promise.resolve({ data: { user: null }, error: { message: 'offline' } })
			}
		};
		// A transient network failure must not blank the canvas.
		expect(await ensureSession(client)).toBeNull();
	});
});
