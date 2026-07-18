import { expect, test } from '@playwright/test';

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
		.poll(async () => frameA.evaluate((el) => getComputedStyle(el).clipPath))
		.toContain('ellipse');

	// Shape is shared state — B sees the clip too.
	await b.goto(`/hey/${room}`);
	const frameB = b.locator('.frame');
	await expect(frameB).toHaveCount(1);
	await expect
		.poll(async () => frameB.evaluate((el) => getComputedStyle(el).clipPath))
		.toContain('ellipse');

	await context.close();
});
