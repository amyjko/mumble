import { expect, test } from '@playwright/test';
import { SYNC, joinRoom, roomName } from './support/join';

/**
 * Resize + rotate (UX-OBJ-1). Driven by keyboard for determinism (the pointer
 * handles use the same commitTransform path; the transform math is unit-tested
 * in resize.spec.ts). Alt+arrows resize; [ and ] rotate.
 */
test('resize: Alt+Arrow grows a focused object, synced', async ({ browser }) => {
	const room = roomName('rz');
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await joinRoom(a, room);
	await a.getByRole('button', { name: '+ note' }).click();
	const frame = a.locator('.frame');
	await frame.focus();

	const worldWidth = (loc: typeof frame) =>
		loc.evaluate((el) => (el instanceof HTMLElement ? parseFloat(el.style.width) : NaN));
	const before = await worldWidth(frame);

	for (let i = 0; i < 4; i++) await a.keyboard.press('Alt+ArrowRight');
	await expect.poll(async () => worldWidth(frame)).toBeGreaterThan(before);

	// Size is shared state — B sees the new width.
	await joinRoom(b, room);
	const frameB = b.locator('.frame');
	await expect(frameB).toHaveCount(1);
	await expect.poll(async () => worldWidth(frameB), { timeout: SYNC }).toBeGreaterThan(before);

	await context.close();
});

test('rotate: [ and ] keys rotate a focused object', async ({ page }) => {
	await joinRoom(page, roomName('rot'));
	await page.getByRole('button', { name: '+ note' }).click();
	const frame = page.locator('.frame');
	await frame.focus();
	await page.keyboard.press(']');
	await page.keyboard.press(']');
	await expect
		.poll(async () => frame.evaluate((el) => el instanceof HTMLElement ? el.style.transform : ''))
		.toContain('rotate(30deg)');
});
