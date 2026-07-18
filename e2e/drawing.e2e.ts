import { expect, test } from '@playwright/test';

/** Drawings (UX-OBJ-11): draw mode captures a stroke into a synced drawing object. */
test('drawing: a stroke drawn in A becomes a drawing and syncs to B', async ({ browser }) => {
	const room = `draw-${Date.now().toString(36)}`;
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await a.goto(`/hey/${room}`);
	const canvas = a.getByRole('application', { name: 'Room canvas' });
	await expect(canvas).toBeVisible();
	await a.getByRole('button', { name: '✎ draw' }).click();

	// Draw a stroke on empty canvas (top-left, away from the avatar at center).
	await a.mouse.move(120, 200);
	await a.mouse.down();
	await a.mouse.move(200, 260, { steps: 5 });
	await a.mouse.move(300, 220, { steps: 5 });
	await a.mouse.up();

	// A drawing object (svg path) now exists and syncs to B.
	await expect(a.locator('.drawing path')).toHaveCount(1);
	await b.goto(`/hey/${room}`);
	await expect(b.locator('.drawing path')).toHaveCount(1);

	await context.close();
});
