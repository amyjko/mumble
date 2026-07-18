import { expect, test } from '@playwright/test';
import { joinRoom, roomName } from './support/join';

/**
 * Raise-hand (UX-AV-6) is now the slot-request QUEUE ENTRY, not a decorative
 * persistent emote — which changes this test's premise.
 *
 * It used to assert that a raised hand persists. It no longer can: raising is
 * queueing, so with a slot free you are promoted into it immediately and there
 * is nothing left to wait for. The hand exists strictly for contention, which
 * is why the room has to be made scarce before any of this means anything.
 */
async function removeAllSlots(page: import('@playwright/test').Page): Promise<void> {
	await page.getByRole('button', { name: /^stage/ }).click();
	for (const field of ['Video slots', 'Audio slots']) {
		await page.getByRole('textbox', { name: field }).fill('0');
		await page.getByRole('textbox', { name: field }).blur();
	}
	await page.keyboard.press('Escape');
}

test('raise hand is the queue entry, and syncs to peers', async ({ browser }) => {
	const room = roomName('emote');
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await joinRoom(a, room);
	await removeAllSlots(a);

	await a.getByRole('button', { name: 'Raise hand to queue' }).click();
	await expect(a.locator('.avatar.raised')).toHaveCount(1);

	// The queue is shared room state, so a peer sees the raised hand too.
	// Self-only remains structural: the one bar can address nobody but you,
	// and the store rejects the attempt (memory-store.spec.ts covers that).
	await joinRoom(b, room);
	await expect(b.locator('.avatar.raised')).toHaveCount(1);

	await context.close();
});

/** Lowering leaves the queue — the same fact from the other side. */
test('lowering a hand leaves the queue', async ({ page }) => {
	await joinRoom(page, roomName('lower'));
	await removeAllSlots(page);

	await page.getByRole('button', { name: 'Raise hand to queue' }).click();
	await expect(page.locator('.avatar.raised')).toHaveCount(1);

	await page.getByRole('button', { name: /Lower hand/ }).click();
	await expect(page.locator('.avatar.raised')).toHaveCount(0);
});
