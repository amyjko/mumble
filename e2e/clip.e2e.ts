import { expect, test } from '@playwright/test';

/**
 * The clip lives on the inner .clip layer, not .frame: clip-path clips
 * hit-testing for all descendants, so applying it to the frame erased the
 * object's own handles and shape button and trapped it in that shape.
 */

/** Clip shapes (UX-OBJ-7): cycling reaches ellipse/polygon (a real clip-path). */
test('clip: cycling an object shape applies a clip-path and syncs', async ({ browser }) => {
	const room = `clip-${Date.now().toString(36)}`;
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await a.goto(`/hey/${room}`);
	await expect(a.getByRole('application', { name: 'Room canvas' })).toBeVisible();
	await a.getByRole('button', { name: '+ note' }).click();
	const frameA = a.locator('.frame');
	await frameA.hover();

	const shapeBtn = a.getByRole('button', { name: /Change shape/ });
	// rounded -> circle -> ellipse (a clip-path shape)
	await shapeBtn.click();
	await shapeBtn.click();
	await expect(a.getByRole('button', { name: /currently ellipse/ })).toBeVisible();
	await expect
		.poll(async () => frameA.locator('.clip').evaluate((el) => getComputedStyle(el).clipPath))
		.toContain('ellipse');

	// Shape is shared state — B sees the clip too.
	await b.goto(`/hey/${room}`);
	const frameB = b.locator('.frame');
	await expect(frameB).toHaveCount(1);
	await expect
		.poll(async () => frameB.locator('.clip').evaluate((el) => getComputedStyle(el).clipPath))
		.toContain('ellipse');

	await context.close();
});

/**
 * The trap regression. With clip-path on .frame, an ellipse or polygon
 * silhouette clipped away every control that sits outside it — the corner
 * handles, the rotate grip, AND the shape button itself — so once you reached
 * ellipse there was no pointer route back out; only the `c` key escaped.
 * Every shape in the cycle must stay pointer-operable.
 */
test('clip: controls stay reachable in every shape (no trapped object)', async ({ page }) => {
	const room = `cliptrap-${Date.now().toString(36)}`;
	await page.goto(`/hey/${room}`);
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();
	await page.getByRole('button', { name: '+ note' }).click();

	const frame = page.locator('.frame');
	await frame.hover();

	// Walk the whole cycle by POINTER, asserting each step actually landed.
	// If the control were clipped away, the click would time out here.
	for (const shape of ['circle', 'ellipse', 'polygon', 'rect']) {
		await page.getByRole('button', { name: /Change shape/ }).click();
		await expect(page.getByRole('button', { name: new RegExp(`currently ${shape}`) })).toBeVisible();
	}

	// The corner handles and rotate grip must also survive the clip: they sit
	// outside the silhouette on every non-rect shape.
	await page.getByRole('button', { name: /Change shape/ }).click(); // -> rounded
	await page.getByRole('button', { name: /Change shape/ }).click(); // -> circle
	await page.getByRole('button', { name: /Change shape/ }).click(); // -> ellipse
	await expect(page.getByRole('button', { name: /currently ellipse/ })).toBeVisible();
	await frame.hover();
	await expect(page.getByRole('button', { name: 'Resize from nw' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Rotate' })).toBeVisible();
	// Clickable, not merely painted — hit-testing is what clip-path took away.
	await page.getByRole('button', { name: 'Resize from se' }).click({ trial: true });
});
