import { expect, test } from '@playwright/test';
import { joinRoom, roomName } from './support/join';

/**
 * Behaviors that were built and shipped without a single test.
 *
 * These came out of a full audit of DESIGN.md against the code: each was
 * classified PARTIAL for exactly one reason — it works, and nothing asserted
 * that it works. That is the most expensive kind of gap, because it looks
 * finished from every angle except a regression.
 *
 * Two siblings deliberately do NOT live here. Pointer gestures do not drive
 * the app under Playwright — a resize-handle drag moves an object by exactly
 * zero pixels — so the snap hint and the rejected-placement revert were
 * written here first and PASSED WITHOUT ASSERTING ANYTHING (non-overlap is
 * free when nothing moves). They now live in ObjectFrame.svelte.spec.ts and
 * HintBar.svelte.spec.ts, under browser mode's real pointer capture. This is
 * also why resize.e2e.ts drives the keyboard.
 */

/** UX-CANVAS-2: the camera is per-viewer and must never enter room state. */
test('one viewer panning does not move anyone else', async ({ browser }) => {
	const room = roomName('pan');
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();
	await joinRoom(a, room);
	await joinRoom(b, room);

	const worldOf = async (page: typeof a): Promise<string> =>
		page.locator('.world').evaluate((el) => (el instanceof HTMLElement ? el.style.transform : ''));

	const bBefore = await worldOf(b);

	// Drag the background, which is what pans.
	const canvas = a.getByRole('application', { name: 'Room canvas' });
	const box = await canvas.boundingBox();
	if (box === null) throw new Error('canvas has no box');
	await a.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8);
	await a.mouse.down();
	await a.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 8 });
	await a.mouse.up();

	await expect.poll(async () => worldOf(a)).not.toBe(bBefore);
	// The structural guarantee, now actually asserted: B never moved.
	expect(await worldOf(b)).toBe(bBefore);

	await context.close();
});

/** UX-OBJ-10: content survives a reload. Stub-backed, but the claim is the same. */
test('objects survive a reload', async ({ page }) => {
	await joinRoom(page, roomName('persist'));
	await page.getByRole('button', { name: '+ note' }).click();
	await expect(page.locator('.frame')).toHaveCount(1);

	await page.reload();
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();
	await expect(page.locator('.frame')).toHaveCount(1);
});

/** UX-OBJ-14: a hovered object raises above its neighbours for interactivity. */
test('hovering raises an object above its neighbours', async ({ page }) => {
	await joinRoom(page, roomName('raise'));
	await page.getByRole('button', { name: '+ note' }).click();
	const frame = page.locator('.frame').first();

	const z = async (): Promise<string> =>
		frame.evaluate((el) => getComputedStyle(el).zIndex);

	const resting = await z();
	await frame.hover();
	const hovered = await z();

	expect(Number(hovered)).toBeGreaterThan(Number(resting));
	// It must also come back down, or the last-hovered object wins forever.
	await page.mouse.move(0, 0);
	await expect.poll(z).toBe(resting);
});

/** UX-A11Y-4: motion is a courtesy. The media query existed, untested. */
test('reduced motion collapses animation durations', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await joinRoom(page, roomName('motion'));
	await page.getByRole('button', { name: '+ note' }).click();

	const duration = await page
		.locator('.frame')
		.first()
		.evaluate((el) => getComputedStyle(el).transitionDuration);
	// 0.01ms, not 0s: the rule keeps transitions firing so transitionend still
	// runs, which is why it is a duration collapse rather than `none`.
	expect(parseFloat(duration)).toBeLessThan(0.001);
});
