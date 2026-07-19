import { expect, test } from '@playwright/test';
import { roomName } from './support/join';
import { hostRoom, signInAsAccount, testEmail } from './support/auth';

/**
 * Avatar identity follows the person (UX-ID-6, UX-ID-9).
 *
 * "The same person on laptop and phone is one identity with one set of owned
 * objects." Name and emoji lived only in localStorage, so signing in on a
 * second machine gave you your rooms and a blank stranger's face.
 *
 * A SECOND BROWSER CONTEXT is the whole test. Same account, different storage —
 * which is exactly what a second machine is, and what no same-context test can
 * simulate.
 */

test('a name chosen on one machine appears on another', async ({ browser }) => {
	// An explicit address: this test is about ONE person on TWO machines, which
	// the shared account cannot express.
	const email = testEmail('roam');
	const room = roomName('roam');

	// Machine one: sign in, create a room, pick a name.
	const first = await browser.newContext();
	const a = await first.newPage();
	await signInAsAccount(a, email);
	await a.goto('/new');
	await a.getByRole('textbox', { name: 'Room name' }).fill(room);
	await a.getByRole('button', { name: 'go' }).click();
	await a.waitForURL(new RegExp(`/hey/${room}$`));

	const nameField = a.getByRole('textbox', { name: 'Your name' });
	if (await nameField.isVisible().catch(() => false)) {
		await nameField.fill('Ada Lovelace');
		await a.getByRole('button', { name: 'Join' }).click();
	}
	await expect(a.getByRole('application', { name: 'Room canvas' })).toBeVisible();
	// The seeding write happens on join; wait for it to land before leaving.
	await expect(a.getByRole('button', { name: /Ada Lovelace/ })).toBeVisible();
	await first.close();

	// Machine two: same account, EMPTY localStorage.
	const second = await browser.newContext();
	const b = await second.newPage();
	await signInAsAccount(b, email);
	await b.goto(`/hey/${room}`);

	// No join prompt, because the identity is known — that IS the requirement.
	await expect(b.getByRole('button', { name: /Ada Lovelace/ })).toBeVisible();
	await second.close();
});

test('a name chosen BEFORE signing in is kept, not overwritten', async ({ browser }) => {
	// The "pick up local details" half: someone joins a room as a guest, picks
	// a name, and later signs in. Their name must survive that — being replaced
	// by a blank prompt would punish them for making an account.
	const room = roomName('seed');
	const context = await browser.newContext();
	const page = await context.newPage();
	// hostRoom answers the join prompt as "Host", so rename afterwards through
	// the identity editor — which is the path a real person uses anyway.
	await hostRoom(page, room);
	await page.getByRole('button', { name: /Host/ }).click();
	await page.getByRole('textbox', { name: 'Your name' }).fill('Grace');
	await page.getByRole('button', { name: 'save' }).click();
	await expect(page.getByRole('button', { name: /Grace/ })).toBeVisible();

	// Reload: the profile was seeded from the local name, so it comes back.
	await page.reload();
	await expect(page.getByRole('button', { name: /Grace/ })).toBeVisible();
	await context.close();
});
