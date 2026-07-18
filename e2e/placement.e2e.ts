import { expect, test } from '@playwright/test';
import { joinRoom, roomName } from './support/join';

/**
 * Placement (UX-AV-2/9, AR-CTRL-4/6). Only the third resolution step existed
 * before — a participant arrived wherever the caller suggested and was nudged
 * to a legal spot. The drop-in point and per-configuration memory are what
 * make "arriving never displaces anyone" and "you return where you were" true.
 */

test('placement: the drop-in marker is present, draggable, and not an object', async ({ page }) => {
	await joinRoom(page, roomName('drop'));

	const marker = page.getByRole('group', {
		name: /Drop-in point/
	});
	await expect(marker).toBeVisible();

	// It is a MARKER, not an object: it has no object frame, so none of the
	// object chrome (delete, shape, permission) applies to it, and it never
	// appears in an object layout.
	await expect(page.locator('.frame')).toHaveCount(0);

	// Keyboard-movable like everything else on the canvas (UX-A11Y-2).
	const before = await marker.evaluate((el) => (el instanceof HTMLElement ? el.style.transform : ''));
	await marker.focus();
	await page.keyboard.press('ArrowRight');
	await expect
		.poll(async () => marker.evaluate((el) => (el instanceof HTMLElement ? el.style.transform : '')))
		.not.toBe(before);
});

test('placement: you return to where you were, per configuration', async ({ page }) => {
	const room = roomName('remember');
	await joinRoom(page, room);

	// Move, then save that as a configuration.
	const avatar = page.locator('.avatar');
	await avatar.focus();
	for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
	// The keyboard move commits on a debounce; let it land.
	await page.waitForTimeout(400);
	const moved = await avatar.evaluate((el) => (el instanceof HTMLElement ? el.style.transform : ''));

	await page.reload();
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();

	// Rejoining puts you back where you were, rather than at the drop-in point.
	await expect
		.poll(async () => page.locator('.avatar').evaluate((el) => (el instanceof HTMLElement ? el.style.transform : '')))
		.toBe(moved);
});
