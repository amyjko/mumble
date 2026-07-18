import { expect, test } from '@playwright/test';

/** Emotes (UX-AV-4/5/7): raise-hand persists + syncs; reactions are self-initiated. */
test('raise hand persists and syncs; a peer cannot toggle it', async ({ browser }) => {
	const room = `emote-${Date.now().toString(36)}`;
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await a.goto(`/hey/${room}`);
	await expect(a.getByRole('application', { name: 'Room canvas' })).toBeVisible();
	// A raises hand from the dedicated emote bar. It used to hang off your own
	// avatar and appear only on hover, which was hard to find and unreachable
	// on touch; there is now exactly one always-visible launcher.
	await a.getByRole('button', { name: 'Raise hand' }).click();
	await expect(a.locator('.avatar.raised')).toHaveCount(1);

	// B sees A's raised hand (persistent, synced). Self-only is now structural:
	// the single bar can address nobody but you, and the store enforces it too
	// (memory-store.spec.ts covers the rejection).
	await b.goto(`/hey/${room}`);
	await expect(b.locator('.avatar.raised')).toHaveCount(1);

	await context.close();
});
