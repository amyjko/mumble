import { expect, test } from '@playwright/test';
import { joinRoom, roomName, settled } from './support/join';

/** Configurations (UX-ROOM-3..6): save a layout, change it, switch back restores. */
test('config: save layout, move object, switch back restores position', async ({ page }) => {
	await joinRoom(page, roomName('cfg'));
	await page.getByRole('button', { name: '+ note' }).click();
	const frame = page.locator('.frame');
	const worldX = () => frame.evaluate((el) => (el instanceof HTMLElement ? el.style.transform : ''));

	// Save current layout as a configuration.
	await page.getByRole('button', { name: /layouts/ }).click();
	await page.getByRole('textbox', { name: 'Layout name' }).fill('Start');
	await page.getByRole('button', { name: 'save', exact: true }).click();
	const saved = await worldX();

	// Move the note far away.
	await frame.focus();
	for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
	// The debounced keyboard-move commit MUST land before switching: a late
	// one clobbers the restore, so losing this race writes the wrong value and
	// the assertion below then fails permanently rather than slowly. A fixed
	// sleep was a fair bet against localStorage and is a coin toss against a
	// network round trip.
	await settled(page);
	await expect.poll(worldX).not.toBe(saved);

	// The configs popover is still open — switch back to the saved config.
	await page.getByRole('button', { name: 'Start', exact: true }).click();
	await expect.poll(worldX).toBe(saved);
});
