import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';

/**
 * Sign a browser in, offline (AR-TEST-8).
 *
 * "Magic link by generating the link server-side and verifying the token hash,
 * needing no email scraping." The admin API mints the link, we pull the token
 * hash out of it, and the browser visits our own confirm route — so the test
 * exercises the REAL callback rather than a fabricated cookie.
 *
 * The secret key never reaches the browser and never enters the repo; it comes
 * from the local stack's env (AR-DEPLOY-6).
 */
const url = process.env['PUBLIC_SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const secret = process.env['SUPABASE_SECRET_KEY'] ?? '';

/**
 * ONE admin client for the whole worker.
 *
 * A client per call is a connection pool per call. With ~85 tests each creating
 * a room and an account, the local stack ran out of connections part-way
 * through and every later test failed with "Timed out acquiring connection from
 * connection pool" — which looks exactly like broken application code and is
 * not. The same bug existed server-side and was fixed there; this is the copy
 * that survived, and it invalidated two full-suite measurements before I
 * noticed I was testing against a degraded stack rather than my changes.
 */
let admin: ReturnType<typeof createClient> | null = null;
function adminClient(): ReturnType<typeof createClient> {
	if (admin === null) {
		admin = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });
	}
	return admin;
}

/** A fresh address per call: reusing one trips Auth's rate limits mid-suite. */
export function testEmail(prefix = 'host'): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}@example.test`;
}

/**
 * One account PER WORKER, reused across that worker's tests.
 *
 * Two failure modes, and this sits between them. An account per TEST exhausted
 * the local stack's connection pool part-way through the suite, and every later
 * test failed with "Timed out acquiring connection from connection pool" —
 * which reads as a broken app and is really a greedy harness. But ONE account
 * for the whole run races: workers run in parallel, magic links are single-use,
 * and signing in again rotates the session out from under another worker's
 * test, which surfaces as an unrelated click timing out.
 *
 * Per-worker is a handful of accounts instead of ninety, with no sharing across
 * anything that runs concurrently. Tests that need two DISTINCT people still
 * pass an explicit email.
 */
const workerEmails = new Map<number, string>();

export async function signInAsAccount(page: Page, email?: string): Promise<string> {
	if (email !== undefined) return signInAs(page, email);
	const worker = test.info().parallelIndex;
	let mine = workerEmails.get(worker);
	if (mine === undefined) {
		mine = testEmail(`w${String(worker)}`);
		workerEmails.set(worker, mine);
	}
	return signInAs(page, mine);
}

async function signInAs(page: Page, email: string): Promise<string> {
	const admin = adminClient();

	// Create the user FIRST, confirmed. generateLink({type:'magiclink'}) on an
	// unknown address succeeds — it creates the user — but then issues a SIGNUP
	// token, which fails verification as a magiclink with the same opaque
	// "Email link is invalid or has expired" a forged link gives. Doing it in
	// two steps means this exercises the genuine magic-link path (AR-TEST-8)
	// rather than a signup confirmation wearing its name.
	// Idempotent by intent: the shared account already exists after the first
	// call, and "already registered" is the expected answer, not a failure.
	await admin.auth.admin.createUser({ email, email_confirm: true });

	const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
	if (error !== null) {
		// A missing or blank secret key surfaces here as something unhelpful, so
		// say what it actually means.
		throw new Error(`generateLink failed (is SUPABASE_SECRET_KEY set?): ${error.message}`);
	}

	const tokenHash = data.properties.hashed_token;
	await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=magiclink&next=/`);
	// generateLink always returns a user on success; the types say so.
	return data.user.id;
}

/**
 * Sign in, create the room, and enter it as its host.
 *
 * Being a host is not a client-side flag: it is a `room_members` row, and only
 * a room that EXISTS in Postgres can have one. So a test that needs host powers
 * has to create the room, which means an account (AR-AUTH-7) — the sequence is
 * the requirement, not ceremony.
 *
 * Guests keep using `joinRoom`, which needs none of this.
 */
export async function hostRoom(page: Page, room: string, name = 'Host'): Promise<void> {
	await signInAsAccount(page);
	await page.goto('/new');
	await page.getByRole('textbox', { name: 'Room name' }).fill(room);
	await page.getByRole('button', { name: 'go' }).click();
	await page.waitForURL(new RegExp(`/hey/${room}$`));

	/*
	 * The prompt may never appear, and may appear and then LEAVE.
	 *
	 * Since avatar identity roams (UX-ID-6), an account that has been used
	 * before arrives with a stored profile — which lands asynchronously and
	 * dismisses the prompt. Checking `isVisible()` and then filling races that:
	 * the check passes, the profile arrives, and the fill times out against an
	 * element that is legitimately gone. So wait for EITHER outcome first, the
	 * same way joinRoom does, and treat a vanished prompt as success.
	 */
	const nameField = page.getByRole('textbox', { name: 'Your name' });
	const canvas = page.getByRole('application', { name: 'Room canvas' });
	await expect(nameField.or(canvas).first()).toBeVisible();

	if (await nameField.isVisible().catch(() => false)) {
		await nameField.fill(name, { timeout: 5000 }).catch(() => {
			// The profile resolved first and dismissed the prompt. Nothing to do.
		});
		await page.getByRole('button', { name: 'Join' }).click({ timeout: 5000 }).catch(() => {});
	}
	await expect(canvas).toBeVisible();
	await expect(page.getByRole('button', { name: /newcomer spot/ })).toBeVisible();
}

/**
 * Create a room WITHOUT a browser, for tests that only need it to exist.
 *
 * Rooms are real now, so visiting one no longer conjures it — but going through
 * /new would make every test's user an account holder AND the room's host,
 * which is the opposite of the common case (UX-ROOM-11: joining needs no
 * account). Creating it out-of-band keeps the browser anonymous, so the default
 * test user stays a GUEST and the guest path keeps its coverage.
 *
 * `owner` defaults to a throwaway account that never appears in a browser.
 */
export async function createRoomDirectly(room: string, owner?: string): Promise<string> {
	const admin = adminClient();

	let ownerId = owner;
	if (ownerId === undefined) {
		const email = testEmail('owner');
		const { data } = await admin.auth.admin.createUser({ email, email_confirm: true });
		ownerId = data.user?.id ?? '';
	}

	const { data, error } = await admin.from('rooms').insert({ name: room, owner_id: ownerId }).select('id').single();
	if (error !== null) throw new Error(`could not create room ${room}: ${error.message}`);
	// The generated row type is Json-shaped, so narrow rather than return `any`.
	const id: unknown = data.id;
	if (typeof id !== 'string') throw new Error(`room ${room} returned no id`);
	return id;
}
