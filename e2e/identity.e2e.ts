import { expect, test } from '@playwright/test';
import { joinRoom, roomName } from './support/join';
import { createRoomDirectly } from './support/auth';

/**
 * Identity (UX-ID-1, UX-AV-3). Joining may be anonymous — no account — but a
 * NAME IS REQUIRED. The app used to invent `guest-473`, never ask, and offer
 * no way to change it; `saveIdentity` was exported and never called.
 */

test('a room cannot be entered without a name', async ({ page }) => {
	// Navigated directly rather than through joinRoom, because joinRoom ANSWERS
	// the prompt and the prompt is what this test is about. So the room is
	// created here instead.
	const room = roomName('id');
	await createRoomDirectly(room);
	await page.goto(`/hey/${room}`);

	// The prompt blocks entry, and Join stays disabled until a name is typed.
	const join = page.getByRole('button', { name: 'Join' });
	await expect(join).toBeVisible();
	await expect(join).toBeDisabled();
	await expect(page.getByRole('application', { name: 'Room canvas' })).toHaveCount(0);

	await page.getByRole('textbox', { name: 'Your name' }).fill('Amy');
	await expect(join).toBeEnabled();
	await join.click();
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();
});

test('the chosen name and face are shown, and survive a reload', async ({ page }) => {
	const room = roomName('id-keep');
	await joinRoom(page, room, 'Amy');

	// The name appears on your own avatar (marked as yours).
	await expect(page.getByRole('group', { name: 'Amy (you)' })).toBeVisible();

	// Reload: no second prompt, because the identity persisted.
	await page.reload();
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Join' })).toHaveCount(0);
	await expect(page.getByRole('group', { name: 'Amy (you)' })).toBeVisible();
});

test('name and face can be changed afterwards (UX-AV-3)', async ({ page }) => {
	const room = roomName('id-edit');
	await joinRoom(page, room, 'Amy');

	await page.getByRole('button', { name: /Amy/ }).click();
	await page.getByRole('textbox', { name: 'Your name' }).fill('Renamed');
	// Pick a different face from the radiogroup.
	const faces = page.getByRole('radiogroup', { name: 'Your face' }).getByRole('radio');
	await faces.nth(3).click();
	await page.getByRole('button', { name: 'save' }).click();

	await expect(page.getByRole('group', { name: 'Renamed (you)' })).toBeVisible();

	// And it persists — the previous implementation could not do this at all,
	// since nothing ever wrote the identity back.
	await page.reload();
	await expect(page.getByRole('group', { name: 'Renamed (you)' })).toBeVisible();
});
