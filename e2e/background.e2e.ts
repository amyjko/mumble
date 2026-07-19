import { expect, test } from '@playwright/test';
import { joinRoom, roomName } from './support/join';

/** Canvas background (UX-CANVAS-5): shared room state, applied to the canvas. */
test('background: a preset chosen in A applies and syncs to B', async ({ browser }) => {
	const room = roomName('bg');
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await joinRoom(a, room);
	const canvasA = a.getByRole('application', { name: 'Room canvas' });
	await expect(canvasA).toBeVisible();
	const before = await canvasA.evaluate((el) => getComputedStyle(el).backgroundColor);

	// Popover trigger (was a <details><summary>), then a brightness level
	// (the named presets Paper/Slate/Dawn/Spotlight are gone — they named
	// nothing rankable, see BACKGROUND_LEVELS).
	await a.getByRole('button', { name: /background/ }).click();
	await a.getByRole('button', { name: 'Brightness 5, brightest' }).click();

	// backgroundCOLOR, not backgroundImage: the ramp is solid colors. The old
	// presets were gradients, which is the only reason the image property was
	// the right thing to watch before.
	await expect
		.poll(async () => canvasA.evaluate((el) => getComputedStyle(el).backgroundColor))
		.not.toBe(before);

	// A second viewer sees the same room background.
	await joinRoom(b, room);
	const canvasB = b.getByRole('application', { name: 'Room canvas' });
	await expect(canvasB).toBeVisible();
	await expect
		.poll(async () => canvasB.evaluate((el) => getComputedStyle(el).backgroundColor))
		.not.toBe(before);

	await context.close();
});
