import { expect, test } from '@playwright/test';

/** Canvas background (UX-CANVAS-5): shared room state, applied to the canvas. */
test('background: a preset chosen in A applies and syncs to B', async ({ browser }) => {
	const room = `bg-${Date.now().toString(36)}`;
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await a.goto(`/hey/${room}`);
	const canvasA = a.getByRole('application', { name: 'Room canvas' });
	await expect(canvasA).toBeVisible();
	const before = await canvasA.evaluate((el) => getComputedStyle(el).backgroundImage);

	await a.getByRole('group').getByText('background').click(); // open <details>
	await a.getByRole('button', { name: 'Dawn' }).click();

	// The canvas background changed (a gradient is now applied).
	await expect
		.poll(async () => canvasA.evaluate((el) => getComputedStyle(el).backgroundImage))
		.not.toBe(before);

	// A second viewer sees the same room background.
	await b.goto(`/hey/${room}`);
	const canvasB = b.getByRole('application', { name: 'Room canvas' });
	await expect(canvasB).toBeVisible();
	await expect
		.poll(async () => canvasB.evaluate((el) => getComputedStyle(el).backgroundImage))
		.not.toBe(before);

	await context.close();
});
