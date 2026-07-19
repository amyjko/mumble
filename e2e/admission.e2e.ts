import { expect, test } from '@playwright/test';
import { SYNC, joinRoom, roomName, settled } from './support/join';
import { hostRoom } from './support/auth';

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
	await guest.goto(`/hey/${room}`);
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

	await guest.goto(`/hey/${room}`);
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
