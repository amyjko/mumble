import { expect, test } from '@playwright/test';
import { joinRoom, roomName } from './support/join';

/**
 * Scale-to-fullscreen (UX-CANVAS-4): per-viewer view state — opens an overlay,
 * Escape restores, and it mutates nothing shared (object count unchanged, and a
 * peer is unaffected).
 */
test('fullscreen: overlay opens, Escape closes, nothing is mutated', async ({ browser }) => {
	const room = roomName('fs');
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await joinRoom(a, room);
	await a.getByRole('button', { name: '+ note' }).click();
	await joinRoom(b, room);
	await expect(b.locator('.frame')).toHaveCount(1);

	// Fill the screen with the note.
	await a.getByRole('button', { name: 'Fill screen with this object' }).click();
	const overlay = a.getByRole('dialog', { name: 'Fullscreen object' });
	await expect(overlay).toBeVisible();
	await expect(overlay.locator('textarea.note')).toBeVisible();

	// Per-viewer: the peer has no overlay, and the object count is unchanged.
	await expect(b.getByRole('dialog')).toHaveCount(0);
	await expect(b.locator('.frame')).toHaveCount(1);

	// Escape restores the prior view.
	await a.keyboard.press('Escape');
	await expect(a.getByRole('dialog')).toHaveCount(0);
	await expect(a.locator('.frame')).toHaveCount(1);

	await context.close();
});
