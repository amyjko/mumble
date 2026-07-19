import { expect, test } from '@playwright/test';
import { joinRoom, roomName } from './support/join';

/**
 * Floating chrome behavior. The menus were <details> elements with no
 * coordination at all: several could be open at once, clicking outside left
 * them open, and Escape did nothing. They are now Popover API `auto` popovers,
 * which supply all three behaviors natively — these tests pin that they are
 * actually wired, since the whole point of choosing the platform feature was
 * to get the behavior rather than hand-roll it.
 */

test('chrome: only one menu is open at a time', async ({ page }) => {
	const room = roomName('chrome');
	await joinRoom(page, room);

	const configs = page.locator('#config-menu');
	const background = page.locator('#bg-menu');

	await page.getByRole('button', { name: /layouts/ }).click();
	await expect(configs).toBeVisible();
	await expect(background).toBeHidden();

	// Opening another menu closes the first — no stacking.
	await page.getByRole('button', { name: /background/ }).click();
	await expect(background).toBeVisible();
	await expect(configs).toBeHidden();
});

test('chrome: clicking outside dismisses the open menu', async ({ page }) => {
	const room = roomName('chrome-out');
	await joinRoom(page, room);

	const background = page.locator('#bg-menu');
	await page.getByRole('button', { name: /background/ }).click();
	await expect(background).toBeVisible();

	// Light dismiss: a click on the canvas, far from the menu.
	await page.mouse.click(400, 500);
	await expect(background).toBeHidden();
});

test('chrome: Escape dismisses the open menu', async ({ page }) => {
	const room = roomName('chrome-esc');
	await joinRoom(page, room);

	const configs = page.locator('#config-menu');
	await page.getByRole('button', { name: /layouts/ }).click();
	await expect(configs).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(configs).toBeHidden();
});

/**
 * Maximize must cover the floating chrome. The overlay is nested inside
 * `main`, so no z-index could lift it above a fixed toolbar living in the ROOT
 * stacking context — it was occluded no matter how high it bid. A modal
 * <dialog> renders in the top layer, which sidesteps stacking contexts
 * entirely, and inerts the rest of the page as a bonus.
 */
test('chrome: a maximized object covers the toolbar and holds focus', async ({ page }) => {
	const room = roomName('chrome-fs');
	await joinRoom(page, room);
	await page.getByRole('button', { name: '+ note' }).click();
	await page.locator('.frame').hover();
	await page.getByRole('button', { name: 'Fill screen with this object' }).click();

	const dialog = page.getByRole('dialog', { name: 'Fullscreen object' });
	await expect(dialog).toBeVisible();

	// The chrome sits under the dialog: hit-testing at the toolbar's own
	// coordinates must NOT reach a toolbar button.
	const covered = await page.evaluate(() => {
		const bar = document.querySelector('header.bar');
		if (!(bar instanceof HTMLElement)) return null;
		const box = bar.getBoundingClientRect();
		const hit = document.elementFromPoint(box.left + 8, box.top + 8);
		return { reachesBar: bar.contains(hit) };
	});
	expect(covered).not.toBeNull();
	expect(covered?.reachesBar).toBe(false);

	// Modal semantics: focus cannot reach any CONTROL outside the dialog. The
	// previous overlay claimed aria-modal="true" but had no trap at all, so Tab
	// walked straight out into the live canvas behind it.
	//
	// The assertion allows <body>: when the tab cycle wraps from the last
	// tabbable back to the first, the browser parks focus on the document
	// itself for one step. That is the wrap point, not an escape — what must
	// never happen is a real control outside the dialog taking focus.
	for (let i = 0; i < 6; i++) {
		await page.keyboard.press('Tab');
		const landing = await page.evaluate(() => {
			const dialog = document.querySelector('dialog[open]');
			const active = document.activeElement;
			if (!(dialog instanceof HTMLElement) || active === null) return 'unknown';
			if (dialog.contains(active)) return 'inside';
			if (active === document.body || active === document.documentElement) return 'wrap';
			return `ESCAPED:${active.tagName}`;
		});
		expect(landing).not.toContain('ESCAPED');
	}

	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(page.getByRole('button', { name: '+ note' })).toBeVisible();
});

/**
 * The toolbar was one hard non-wrapping flex row with no max-width, so on a
 * narrow window its right-hand controls ran off-screen — and `main` is
 * `fixed; inset: 0`, so there was no scroll to reach them either. It must now
 * stay inside the viewport and wrap instead.
 */
test('chrome: the toolbar stays within a narrow viewport', async ({ page }) => {
	const room = roomName('chrome-narrow');
	await page.setViewportSize({ width: 560, height: 800 });
	await joinRoom(page, room);

	const overflow = await page.locator('header.bar').evaluate((el) => {
		const box = el.getBoundingClientRect();
		return { right: box.right, viewport: window.innerWidth };
	});
	expect(overflow.right).toBeLessThanOrEqual(overflow.viewport);

	// And its menu opens below the (now taller, wrapped) bar rather than
	// underneath it — the reason the drop offset is measured, not fixed.
	await page.getByRole('button', { name: /layouts/ }).click();
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
