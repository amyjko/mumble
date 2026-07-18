import { expect, test } from '@playwright/test';

/**
 * Floating chrome behavior. The menus were <details> elements with no
 * coordination at all: several could be open at once, clicking outside left
 * them open, and Escape did nothing. They are now Popover API `auto` popovers,
 * which supply all three behaviors natively — these tests pin that they are
 * actually wired, since the whole point of choosing the platform feature was
 * to get the behavior rather than hand-roll it.
 */

test('chrome: only one menu is open at a time', async ({ page }) => {
	const room = `chrome-${Date.now().toString(36)}`;
	await page.goto(`/hey/${room}`);
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();

	const configs = page.locator('#config-menu');
	const background = page.locator('#bg-menu');

	await page.getByRole('button', { name: /configs/ }).click();
	await expect(configs).toBeVisible();
	await expect(background).toBeHidden();

	// Opening another menu closes the first — no stacking.
	await page.getByRole('button', { name: /background/ }).click();
	await expect(background).toBeVisible();
	await expect(configs).toBeHidden();
});

test('chrome: clicking outside dismisses the open menu', async ({ page }) => {
	const room = `chrome-out-${Date.now().toString(36)}`;
	await page.goto(`/hey/${room}`);
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();

	const background = page.locator('#bg-menu');
	await page.getByRole('button', { name: /background/ }).click();
	await expect(background).toBeVisible();

	// Light dismiss: a click on the canvas, far from the menu.
	await page.mouse.click(400, 500);
	await expect(background).toBeHidden();
});

test('chrome: Escape dismisses the open menu', async ({ page }) => {
	const room = `chrome-esc-${Date.now().toString(36)}`;
	await page.goto(`/hey/${room}`);
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();

	const configs = page.locator('#config-menu');
	await page.getByRole('button', { name: /configs/ }).click();
	await expect(configs).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(configs).toBeHidden();
});

/**
 * The toolbar was one hard non-wrapping flex row with no max-width, so on a
 * narrow window its right-hand controls ran off-screen — and `main` is
 * `fixed; inset: 0`, so there was no scroll to reach them either. It must now
 * stay inside the viewport and wrap instead.
 */
test('chrome: the toolbar stays within a narrow viewport', async ({ page }) => {
	const room = `chrome-narrow-${Date.now().toString(36)}`;
	await page.setViewportSize({ width: 560, height: 800 });
	await page.goto(`/hey/${room}`);
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();

	const overflow = await page.locator('header.bar').evaluate((el) => {
		const box = el.getBoundingClientRect();
		return { right: box.right, viewport: window.innerWidth };
	});
	expect(overflow.right).toBeLessThanOrEqual(overflow.viewport);

	// And its menu opens below the (now taller, wrapped) bar rather than
	// underneath it — the reason the drop offset is measured, not fixed.
	await page.getByRole('button', { name: /configs/ }).click();
	const menu = page.locator('#config-menu');
	await expect(menu).toBeVisible();
	const geometry = await page.evaluate(() => {
		const bar = document.querySelector('header.bar');
		const popover = document.querySelector('#config-menu');
		if (!(bar instanceof HTMLElement) || !(popover instanceof HTMLElement)) return null;
		return { barBottom: bar.getBoundingClientRect().bottom, menuTop: popover.getBoundingClientRect().top };
	});
	expect(geometry).not.toBeNull();
	expect(geometry?.menuTop ?? 0).toBeGreaterThanOrEqual(geometry?.barBottom ?? Infinity);
});
