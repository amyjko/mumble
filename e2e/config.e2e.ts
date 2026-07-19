import { expect, test } from '@playwright/test';
import { joinRoom } from './support/join';

/** Configurations (UX-ROOM-3..6): save a layout, change it, switch back restores. */
test('config: save layout, move object, switch back restores position', async ({ page }) => {
	await joinRoom(page, `cfg-${Date.now().toString(36)}`);
	await page.getByRole('button', { name: '+ note' }).click();
	const frame = page.locator('.frame');
	const worldX = () => frame.evaluate((el) => (el instanceof HTMLElement ? el.style.transform : ''));

	// Save current layout as a configuration.
	await page.getByRole('button', { name: /layouts/ }).click();
	await page.getByRole('textbox', { name: 'Configuration name' }).fill('Start');
	await page.getByRole('button', { name: 'save', exact: true }).click();
	const saved = await worldX();

	// Move the note far away.
	await frame.focus();
	for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
	// Let the debounced keyboard-move commit land before switching (else its
	// late commit would clobber the restore).
	await page.waitForTimeout(400);
	await expect.poll(worldX).not.toBe(saved);

	// The configs popover is still open — switch back to the saved config.
	await page.getByRole('button', { name: 'Start', exact: true }).click();
	await expect.poll(worldX).toBe(saved);
});
