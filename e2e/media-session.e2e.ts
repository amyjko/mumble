import { expect, test } from '@playwright/test';
import { SYNC, joinRoom, roomName, settled } from './support/join';
import { adminClient, hostRoom, signInAsAccount, testEmail } from './support/auth';

/**
 * The publish gate (AR-MEDIA-2, AR-CTRL-1, AR-CTRL-3, UX-STAGE-6).
 *
 * No media yet — deliberately. This is the SERVER half: who may publish, decided
 * by the control plane from the same stage predicates the rule engine uses, and
 * refused before a peer connection is ever opened.
 *
 * Driven through the ROUTE rather than the store, because the route is where an
 * attacker arrives. A gate tested only through the UI would pass while the
 * endpoint under it handed grants to anyone who asked.
 */

async function session(page: import('@playwright/test').Page, room: string) {
	return page.request.post(`/api/rooms/${room}/media/session`, { data: {} });
}

test('a member holding no slot is refused a grant', async ({ browser }) => {
	// The core of UX-STAGE-6: "a participant not in a holder list cannot publish
	// by any means". Being IN the room is not being ON the stage.
	const room = roomName('gate');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	await hostRoom(host, room);
	await settled(host);
	await joinRoom(guest, room, 'Lurker');
	await settled(guest);

	const response = await session(guest, room);
	expect(response.status()).toBe(403);

	await hostCtx.close();
	await guestCtx.close();
});

test('taking a slot is what earns a grant', async ({ browser }) => {
	const room = roomName('grant');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	await hostRoom(host, room);
	await settled(host);
	await joinRoom(guest, room, 'Speaker');
	await settled(guest);

	await guest.getByRole('button', { name: /Turn camera on/ }).click();
	await settled(guest);

	const response = await session(guest, room);
	expect(response.status()).toBe(200);

	const body: unknown = await response.json();
	const shape = await guest.evaluate((payload) => {
		if (typeof payload !== 'object' || payload === null) return null;
		const record: Record<string, unknown> = { ...payload };
		const grant = record['grant'];
		const ice = record['iceServers'];
		return {
			hasGrant: typeof grant === 'object' && grant !== null,
			iceCount: Array.isArray(ice) ? ice.length : -1
		};
	}, body);

	expect(shape?.hasGrant).toBe(true);
	// ICE always comes back, even with no TURN configured: locally that is STUN
	// only, which is honest rather than degraded — the relay path has zero local
	// coverage and AR-TEST-10 records it as a prod-only truth.
	expect(shape?.iceCount).toBeGreaterThan(0);

	await hostCtx.close();
	await guestCtx.close();
});

test('a lone occupant gets no session at all (AR-CTRL-3)', async ({ page }) => {
	// "No media session is established for a lone occupant." Enforced here as
	// well as in the client's plan: the client half exists so nobody is prompted
	// for a camera, this half exists so the rule is a fact.
	const room = roomName('alone');
	await hostRoom(page, room);
	await settled(page);

	await page.getByRole('button', { name: /Turn camera on/ }).click();
	await settled(page);

	const response = await session(page, room);
	expect(response.status()).toBe(409);
});

test('a non-member is refused, and a stranger is not told the difference', async ({ page }) => {
	const room = roomName('outsider');
	await hostRoom(page, room);
	await settled(page);

	await page.context().clearCookies();
	await signInAsAccount(page, testEmail('stranger'));
	const response = await session(page, room);
	expect(response.status()).toBe(403);
});

test('signed out is 401', async ({ request }) => {
	const response = await request.post('/api/rooms/whatever/media/session', { data: {} });
	expect(response.status()).toBe(401);
});

test('the public key is served, and is a public key', async ({ request }) => {
	// Peers verify grants locally, so this has to be reachable without a
	// session — a peer may receive an offer before its own session settles.
	const response = await request.get('/api/media/key');
	expect(response.status()).toBe(200);
	const body: unknown = await response.json();
	const text = JSON.stringify(body);
	expect(text).toContain('"kty"');
	// The private scalar must NEVER appear. This is the assertion that would
	// catch a refactor that served the whole JWK.
	expect(text).not.toContain('"d"');
});

test('the grant names the room and the peer it was issued for', async ({ browser }) => {
	// Verified against the DATABASE rather than against what the client thinks:
	// the grant binds to the authenticated actor, and a grant naming somebody
	// else would be useless at best and a forgery vector at worst.
	const room = roomName('bind');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	await hostRoom(host, room);
	await settled(host);
	await joinRoom(guest, room, 'Bound');
	await settled(guest);
	await guest.getByRole('button', { name: /Turn camera on/ }).click();
	await settled(guest);

	const response = await session(guest, room);
	expect(response.status()).toBe(200);
	const payload: unknown = await response.json();

	// Decode the grant body in the page, where atob lives.
	const decoded = await guest.evaluate((body) => {
		if (typeof body !== 'object' || body === null) return null;
		const record: Record<string, unknown> = { ...body };
		const grant = record['grant'];
		if (typeof grant !== 'object' || grant === null) return null;
		const inner: Record<string, unknown> = { ...grant };
		const encoded = inner['body'];
		if (typeof encoded !== 'string') return null;
		const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
		const parsed: unknown = JSON.parse(atob(padded));
		if (typeof parsed !== 'object' || parsed === null) return null;
		const fields: Record<string, unknown> = { ...parsed };
		return {
			room: typeof fields['room'] === 'string' ? fields['room'] : null,
			peer: typeof fields['peer'] === 'string' ? fields['peer'] : null
		};
	}, payload);

	const admin = adminClient();
	const roomRow = await admin.from('rooms').select('id').eq('name', room).single();
	const holders = await admin
		.from('room_state')
		.select('video_holders')
		.eq('room_id', roomRow.data?.id ?? '')
		.single();

	expect(decoded?.room).toBe(roomRow.data?.id);
	expect(holders.data?.video_holders).toEqual([decoded?.peer]);

	await hostCtx.close();
	await guestCtx.close();
});

test('a revoked slot stops earning grants', async ({ browser }) => {
	// The grant is short-lived BECAUSE the holder list is what makes
	// authorization current. Losing the slot must stop new grants immediately,
	// whatever an already-issued one says.
	const room = roomName('revoke');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	await hostRoom(host, room);
	await settled(host);
	await joinRoom(guest, room, 'Briefly');
	await settled(guest);

	await guest.getByRole('button', { name: /Turn camera on/ }).click();
	await settled(guest);
	expect((await session(guest, room)).status()).toBe(200);

	await guest.getByRole('button', { name: /Turn camera off/ }).click();
	await settled(guest);
	await expect.poll(async () => (await session(guest, room)).status(), { timeout: SYNC }).toBe(403);

	await hostCtx.close();
	await guestCtx.close();
});
