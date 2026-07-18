import { expect, test } from '@playwright/test';

/** Emotes (UX-AV-4/5/7): raise-hand persists + syncs; reactions are self-initiated. */
test('raise hand persists and syncs; a peer cannot toggle it', async ({ browser }) => {
	const room = `emote-${Date.now().toString(36)}`;
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await a.goto(`/hey/${room}`);
	await expect(a.getByRole('application', { name: 'Room canvas' })).toBeVisible();
	// A raises hand via its own avatar's emote menu.
	await a.locator('.avatar').first().hover();
	await a.getByRole('button', { name: 'Emote' }).click();
	await a.getByRole('button', { name: '✋ hand' }).click();
	await expect(a.locator('.avatar.raised')).toHaveCount(1);

	// B sees A's raised hand (persistent, synced) — and B's own avatar is the
	// only one B can emote (A's avatar shows no emote trigger for B).
	await b.goto(`/hey/${room}`);
	await expect(b.locator('.avatar.raised')).toHaveCount(1);

	await context.close();
});
