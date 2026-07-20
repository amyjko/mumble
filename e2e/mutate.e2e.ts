import { expect, test } from '@playwright/test';
import { roomName, joinRoom, settled } from './support/join';
import { adminClient, createRoomDirectly, hostRoom, signInAsAccount, testEmail } from './support/auth';

/**
 * The control plane's write path (AR-SYNC-3, AR-CTRL-1).
 *
 * These run through the REAL route with REAL sessions, because the claim being
 * tested is about privilege, not about code: a client holds SELECT and nothing
 * else, so every write it makes must go through here and be judged by the rule
 * engine using an identity the server verified.
 */

test('a mutation round-trips through Postgres', async ({ page }) => {
	const room = roomName('mut');
	await hostRoom(page, room);

	const objectId = crypto.randomUUID();
	const created = await page.request.post(`/api/rooms/${room}/mutate`, {
		data: {
			kind: 'create_object',
			object: {
				id: objectId,
				type: 'note',
				creator_id: '00000000-0000-4000-8000-000000000000',
				permission: 'all',
				hidden: false,
				transform: { x: 0, y: 0, width: 200, height: 160, rotation: 0, z: 1 },
				clip: { shape: 'rect' },
				border: { width: 10 },
				payload: { text: '', doc: '' },
				created_at: '2026-07-19T00:00:00.000Z',
				updated_at: '2026-07-19T00:00:00.000Z'
			}
		}
	});
	expect(created.status(), await created.text()).toBe(200);

	// It persisted: a second mutation sees the first, which it could not if the
	// state were per-request.
	const moved = await page.request.post(`/api/rooms/${room}/mutate`, {
		data: { kind: 'move_object', id: objectId, transform: { x: 320, y: 0, width: 200, height: 160, rotation: 0, z: 1 } }
	});
	expect(moved.status(), await moved.text()).toBe(200);
});

test('an unknown room is 404, not a silent success', async ({ page }) => {
	await signInAsAccount(page);
	const response = await page.request.post('/api/rooms/nosuchroom/mutate', {
		data: { kind: 'set_background', value: '' }
	});
	expect(response.status()).toBe(404);
});

test('a non-member cannot mutate a room they can see', async ({ page }) => {
	// Rooms are addressable by anyone with the link (UX-ROOM-1) — being able to
	// SEE a room is not being in it.
	const room = roomName('closed');
	await hostRoom(page, room);

	await page.context().clearCookies();
	await signInAsAccount(page, testEmail('stranger')); // a DIFFERENT account, never joined
	const response = await page.request.post(`/api/rooms/${room}/mutate`, {
		data: { kind: 'set_background', value: '' }
	});
	expect(response.status()).toBe(403);
});

test('signed out is 401', async ({ request }) => {
	const response = await request.post('/api/rooms/whatever/mutate', {
		data: { kind: 'set_background', value: '' }
	});
	expect(response.status()).toBe(401);
});

test('a malformed mutation is refused by the seam', async ({ page }) => {
	await signInAsAccount(page);
	const response = await page.request.post('/api/rooms/whatever/mutate', {
		data: { kind: 'not_a_real_mutation' }
	});
	expect(response.status()).toBe(400);
});

test('the SERVER enforces host-only settings, not just the UI', async ({ page }) => {
	// The claim AR-SYNC-3 makes and this proves: a client that skips the UI
	// entirely still cannot change room settings it has no role for. The
	// membership row is read server-side, so the request cannot assert a role.
	const room = roomName('gate');
	await hostRoom(page, room);

	// As the host: allowed.
	const asHost = await page.request.post(`/api/rooms/${room}/mutate`, {
		data: { kind: 'set_capacity', capacity: { max_participants: 9, max_av: 2, max_audio: 2 } }
	});
	expect(asHost.status(), await asHost.text()).toBe(200);

	// As a guest who has joined the same room: refused, by the rule engine
	// running on the server with an identity the server verified.
	await page.context().clearCookies();
	await page.goto(`/hey/${room}`);
	const nameField = page.getByRole('textbox', { name: 'Your name' });
	if (await nameField.isVisible().catch(() => false)) {
		await nameField.fill('Guest');
		await page.getByRole('button', { name: 'Join' }).click();
	}
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();
	// The canvas mounts BEFORE the anonymous sign-in resolves — deliberately, so
	// a room never blanks waiting on the network. So wait for the session
	// cookie, or this asserts 401 (no session) instead of 403 (wrong role),
	// which would pass for the wrong reason if the expectation were loosened.
	await expect
		.poll(async () => (await page.context().cookies()).some((c) => c.name.startsWith('sb-')))
		.toBe(true);

	const asGuest = await page.request.post(`/api/rooms/${room}/mutate`, {
		data: { kind: 'set_capacity', capacity: { max_participants: 99, max_av: 9, max_audio: 9 } }
	});
	expect(asGuest.status()).toBe(403);
});

test('a member cannot evict another member, or take their slot (UX-PERM-3)', async ({ browser }) => {
	/*
	 * `remove_participant` drops a participant AND releases both their slots,
	 * and it was UNGUARDED — any admitted member could evict anyone and take
	 * the conch. Measured against this route before the fix: the room went from
	 * `holders=[victim] participants=2` to `holders=[] participants=1`.
	 *
	 * It had no callers in the app, which is how it went unnoticed. The
	 * mutation union is the whole vocabulary of the seam, so an unused verb is
	 * still a reachable one for anything that can POST — which is exactly why
	 * this test drives the ROUTE rather than the store.
	 */
	const room = roomName('evict');
	const roomId = await createRoomDirectly(room);

	const admin = adminClient();

	const victimCtx = await browser.newContext();
	const attackerCtx = await browser.newContext();
	const victim = await victimCtx.newPage();
	const attacker = await attackerCtx.newPage();

	await joinRoom(victim, room, 'Victim');
	await settled(victim);

	// The victim's REAL participant id, from the database rather than the
	// browser — the two are not the same thing.
	const rows = await admin.from('room_participants').select('id').eq('room_id', roomId);
	const victimId = rows.data?.[0]?.id ?? '';
	expect(victimId).not.toBe('');

	await joinRoom(attacker, room, 'Attacker');
	await settled(attacker);

	const response = await attacker.request.post(`/api/rooms/${room}/mutate`, {
		data: { kind: 'remove_participant', id: victimId }
	});
	expect(response.status()).toBe(403);

	// And nothing moved: the victim is still present, still holding nothing
	// that was taken from them.
	const after = await admin.from('room_participants').select('id').eq('room_id', roomId);
	expect(after.data?.map((r) => r.id)).toContain(victimId);

	await victimCtx.close();
	await attackerCtx.close();
});
