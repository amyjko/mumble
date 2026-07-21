import { expect, test } from '@playwright/test';
import { SYNC, joinRoom, roomName, settled } from './support/join';
import { adminClient, createRoomDirectly, hostRoom } from './support/auth';

/**
 * Host admission (UX-ID-2, UX-ID-3, AR-CTRL-5).
 *
 * A guest waiting at the door cannot read ANY of the room: every state table's
 * RLS requires admitted-ness, and so does the room's Realtime channel. So these
 * assert on what the two sides can actually see, which is the same thing the
 * security model enforces — a waiting-room test that passed while the guest
 * could read the canvas would be worse than no test.
 */

test('a guest waits until a host admits them (UX-ID-3)', async ({ browser }) => {
	const room = roomName('door');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	await hostRoom(host, room);

	// The host closes the door.
	await host.getByRole('button', { name: room }).click();
	await host.getByRole('button', { name: 'ask first' }).click();
	await expect(host.getByRole('button', { name: 'ask first' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	// aria-pressed flips OPTIMISTICALLY, so it says nothing about the server.
	// The guest's page reads this setting server-side to decide whether to ask
	// for a hello, so it must actually be persisted before they navigate.
	await settled(host);
	await host.keyboard.press('Escape');

	// The guest arrives and is held, with somewhere to wait rather than a blank
	// page — which is what they would get if the branch were missing, since the
	// canvas cannot load for them at all.
	await guest.goto(`/${room}`);
	await guest.getByRole('textbox', { name: 'Your name' }).fill('Ada');
	await guest.getByRole('textbox', { name: 'Say hello (optional)' }).fill('here for the demo');
	await guest.getByRole('button', { name: 'Ask to join' }).click();

	await expect(guest.getByRole('heading', { name: 'Waiting to be let in' })).toBeVisible();
	// The room itself must NOT be reachable while waiting.
	await expect(guest.getByRole('application', { name: 'Room canvas' })).toHaveCount(0);

	// The host sees them, with the name and the hello.
	await host.getByRole('button', { name: room }).click();
	await expect(host.getByText('At the door (1)')).toBeVisible({ timeout: SYNC });
	await expect(host.getByText('Ada')).toBeVisible();
	await expect(host.getByText('here for the demo')).toBeVisible();

	// Admitted, the guest enters.
	await host.getByRole('button', { name: 'Admit', exact: true }).click();
	await guest.reload();
	await expect(guest.getByRole('application', { name: 'Room canvas' })).toBeVisible({
		timeout: SYNC
	});

	await hostCtx.close();
	await guestCtx.close();
});

test('a host hears a knock without reopening anything (UX-ID-3)', async ({ browser }) => {
	/*
	 * The door channel had NO test, which is how it came to depend on a policy
	 * hole without anyone noticing.
	 *
	 * The admission test above reopens the settings panel before looking, so it
	 * passes whether or not `door:<room>` delivers anything — it exercises the
	 * re-read, not the announcement. But knock_notify.sql exists precisely
	 * because "invisible until a host happens to reopen the panel" is the
	 * failure that makes a door worse than no door.
	 *
	 * So: the host opens the panel FIRST and never touches it again. Anything
	 * that appears, appeared because the database said so.
	 */
	const room = roomName('knock');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	await hostRoom(host, room);
	await host.getByRole('button', { name: room }).click();
	await host.getByRole('button', { name: 'ask first' }).click();
	await settled(host);

	// The panel is open and stays open. The door section does not exist at all
	// while nobody is waiting — it renders only when there is somebody there.
	await expect(host.getByText(/At the door/)).toHaveCount(0);

	await guest.goto(`/${room}`);
	await guest.getByRole('textbox', { name: 'Your name' }).fill('Grace');
	await guest.getByRole('button', { name: 'Ask to join' }).click();
	await expect(guest.getByRole('heading', { name: 'Waiting to be let in' })).toBeVisible();

	// No reload, no reopen, no click of any kind on the host's side.
	await expect(host.getByText('At the door (1)')).toBeVisible({ timeout: SYNC });
	// The NAME, not just the count. A host deciding whether to admit somebody
	// needs to know who they are; "Someone" is what this rendered before the
	// knock was ordered after the profile write.
	await expect(host.getByText('Grace')).toBeVisible({ timeout: SYNC });

	await hostCtx.close();
	await guestCtx.close();
});

test('a declined guest is told, and reloading does not let them in', async ({ browser }) => {
	const room = roomName('decline');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	await hostRoom(host, room);
	await host.getByRole('button', { name: room }).click();
	await host.getByRole('button', { name: 'ask first' }).click();
	await settled(host);
	await host.keyboard.press('Escape');

	await guest.goto(`/${room}`);
	await guest.getByRole('textbox', { name: 'Your name' }).fill('Bo');
	await guest.getByRole('button', { name: 'Ask to join' }).click();
	await expect(guest.getByRole('heading', { name: 'Waiting to be let in' })).toBeVisible();

	await host.getByRole('button', { name: room }).click();
	await expect(host.getByText('At the door (1)')).toBeVisible({ timeout: SYNC });
	await host.getByRole('button', { name: 'Decline', exact: true }).click();

	// The decision is FINAL: `join_room` keeps a standing decision, so a reload
	// must not reopen the door. This is the assertion that would catch a
	// re-join that quietly reset the status to pending.
	await guest.reload();
	await expect(guest.getByRole('heading', { name: 'Not this time' })).toBeVisible({
		timeout: SYNC
	});
	await expect(guest.getByRole('application', { name: 'Room canvas' })).toHaveCount(0);

	await hostCtx.close();
	await guestCtx.close();
});

test('an open room still lets anyone straight in (the default)', async ({ page }) => {
	// The 65 other guest joins in this suite depend on this staying true, and a
	// room that quietly started asking would fail them all at once.
	const room = roomName('open');
	await joinRoom(page, room, 'Anyone');
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Waiting to be let in' })).toHaveCount(0);
});

test('a knock nobody answers expires, and the guest may ask again (AR-CTRL-5)', async ({
	browser
}) => {
	/*
	 * A guest at a room whose host never comes back used to wait in `pending`
	 * forever — still listed at the door months later, and unable to do anything
	 * about it, because `join_room` keeps a standing decision and reloading does
	 * not re-decide.
	 *
	 * The sweep runs in the heartbeat, beside the participant sweep, so this
	 * drives it the way the product does: the host is present and beating.
	 * Winding `updated_at` back stands in for the wait, the same trick the
	 * liveness tests use on `last_seen` — the column is server-written, so
	 * moving it is exactly equivalent to time passing.
	 */
	const room = roomName('stale');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	await hostRoom(host, room);
	await host.getByRole('button', { name: room }).click();
	await host.getByRole('button', { name: 'ask first' }).click();
	await settled(host);
	await host.keyboard.press('Escape');

	await guest.goto(`/${room}`);
	await guest.getByRole('textbox', { name: 'Your name' }).fill('Patient');
	await guest.getByRole('button', { name: 'Ask to join' }).click();
	await expect(guest.getByRole('heading', { name: 'Waiting to be let in' })).toBeVisible();

	// The host sees them, so there is something to expire.
	await host.getByRole('button', { name: room }).click();
	await expect(host.getByText('At the door (1)')).toBeVisible({ timeout: SYNC });
	await host.keyboard.press('Escape');

	// Thirty-one minutes of silence.
	const roomId = await createRoomDirectly(room);
	const { error } = await adminClient()
		.from('room_members')
		.update({ updated_at: new Date(Date.now() - 31 * 60_000).toISOString() })
		.eq('room_id', roomId)
		.eq('status', 'pending');
	if (error !== null) throw new Error(`could not age the knock: ${error.message}`);

	// One beat from anyone present sweeps the door.
	const beat = await host.evaluate(async (name: string) => {
		const response = await fetch(`/api/rooms/${name}/heartbeat`, { method: 'POST' });
		return response.status;
	}, room);
	expect(beat).toBe(200);

	const after = await adminClient()
		.from('room_members')
		.select('identity_id')
		.eq('room_id', roomId)
		.eq('status', 'pending');
	expect(after.data).toEqual([]);

	/*
	 * DELETED, not declined, and this is the assertion that pins the difference.
	 * A decline is a standing decision a reload cannot clear — right when a host
	 * means it, wrong when a host was merely asleep. Removing the row leaves the
	 * guest able to knock again, which is the honest outcome of "nobody
	 * answered".
	 */
	await guest.reload();
	await expect(guest.getByRole('heading', { name: 'Waiting to be let in' })).toBeVisible({
		timeout: SYNC
	});
	await expect(guest.getByRole('heading', { name: 'Not this time' })).toHaveCount(0);

	await hostCtx.close();
	await guestCtx.close();
});

test('the join prompt says an anonymous identity is browser-bound (AR-AUTH-6)', async ({
	page
}) => {
	// "Accepted limitation, surfaced in UX copy" — it was accepted and
	// structural for weeks and surfaced nowhere, so the only people who learned
	// it were the ones it had already surprised.
	const room = roomName('bound');
	await createRoomDirectly(room);
	await page.goto(`/${room}`);
	await expect(page.getByRole('textbox', { name: 'Your name' })).toBeVisible();
	await expect(page.getByText(/keeps you to this browser/)).toBeVisible();
});
