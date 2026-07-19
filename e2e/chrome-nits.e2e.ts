import { expect, test } from '@playwright/test';
import { joinRoom, roomName } from './support/join';

/**
 * A round of review findings, each a small thing that made the product harder
 * to read or use than it needed to be.
 */

test('one bottom toolbar carries emotes, camera, and theme', async ({ page }) => {
	// Three floating clusters used to compete for the bottom of the window —
	// emote bar centre, camera bottom-right, theme bottom-left — and the emote
	// bar wraps, so at most widths it grew straight over the other two.
	await joinRoom(page, roomName('bar'));

	const bar = page.locator('.bottom-bar');
	await expect(bar).toBeVisible();
	for (const name of [/Change theme/, /Step away/, /Auto-fit/, /actual size/]) {
		await expect(bar.getByRole('button', { name })).toBeVisible();
	}
	// And exactly one theme control: the layout-level floating one must stand
	// down inside a room rather than duplicating the toolbar's.
	await expect(page.getByRole('button', { name: /Change theme/ })).toHaveCount(1);
});

test('zoom returns to actual size', async ({ page }) => {
	await joinRoom(page, roomName('zoom'));
	const canvas = page.getByRole('application', { name: 'Room canvas' });

	// Auto-fit is content-relative, so an empty room is nowhere near 1:1.
	await canvas.focus();
	await page.keyboard.press('+');
	await page.keyboard.press('+');

	const actualSize = page.getByRole('button', { name: /actual size/ });
	await actualSize.click();
	await expect(actualSize).toHaveText('100%');
	await expect(actualSize).toHaveAttribute('aria-pressed', 'true');
});

test('add buttons carry a glyph as well as a word', async ({ page }) => {
	await joinRoom(page, roomName('glyph'));
	// In a row of four, the words were the only thing telling them apart.
	const note = page.getByRole('button', { name: '+ note' });
	await expect(note.locator('.emoji')).toHaveCount(1);
});

test('every icon control explains itself on hover AND on focus', async ({ page }) => {
	// The product is full of single-glyph chrome whose meaning lived only in an
	// aria-label: sighted pointer users got the native title after an
	// unpredictable delay, keyboard users got nothing at all.
	await joinRoom(page, roomName('tips'));
	await page.getByRole('button', { name: '+ note' }).click();

	const frame = page.locator('.frame').first();
	await frame.hover();
	const shape = page.getByRole('button', { name: /Change shape/ });
	await shape.hover();
	await expect(page.locator('.tip')).toHaveText(/Change shape/);

	// Keyboard parity is the entire reason this is not `title`.
	await page.mouse.move(0, 0);
	await expect(page.locator('.tip')).toHaveCount(0);
	await shape.focus();
	await expect(page.locator('.tip')).toHaveText(/Change shape/);
});

test('objects can be sent behind and brought in front (UX-OBJ-11)', async ({ page }) => {
	// z existed in the schema and was only ever assigned at creation, so
	// stacking was strictly creation order: a drawing made before a note could
	// never be moved on top of it.
	await joinRoom(page, roomName('depth'));
	await page.getByRole('button', { name: '+ note' }).click();
	await page.getByRole('button', { name: '+ timer' }).click();

	const first = page.locator('.frame').first();

	/**
	 * Relative order of the two frames, with the pointer parked away from both.
	 * Absolute z is the wrong thing to assert twice over: a hovered frame
	 * reports RAISED_Z rather than its own z (UX-OBJ-14), and the raise does
	 * not settle synchronously, so a single sample after moving the mouse can
	 * still read 1100. "Which one is on top" is also just what the feature
	 * means.
	 */
	const firstIsAbove = async (): Promise<boolean | null> => {
		await page.mouse.move(2, 2);
		// BOTH samples in one evaluate, so they describe the same moment. Read
		// sequentially they did not: the hover could settle between the two
		// reads, giving a settled z beside a stale one — a mixed pair that
		// passes the guard below and answers the question wrongly. That is a
		// race no timeout fixes, because each individual read was valid.
		const [a, b] = await page.locator('.frame').evaluateAll((els) =>
			els.slice(0, 2).map((el) => Number(el instanceof HTMLElement ? el.style.zIndex : '0'))
		);
		if (a === undefined || b === undefined) return null;
		// Either frame still showing RAISED_Z means the hover has not settled.
		// Return null and let expect.poll retry — recursing here would either
		// spin without bound or, worse, invert the answer.
		if (a >= 1100 || b >= 1100) return null;
		return a > b;
	};

	// Born second, so the timer starts on top of the note.
	await expect.poll(firstIsAbove).toBe(false);

	await first.hover();
	await page.getByRole('button', { name: /Bring .* in front/ }).first().click();
	await expect.poll(firstIsAbove).toBe(true);

	await first.hover();
	await page.getByRole('button', { name: /Send .* behind/ }).first().click();
	await expect.poll(firstIsAbove).toBe(false);
});

test('a new timer is born big enough for its own controls', async ({ page }) => {
	// It shipped at 180x120 against a 190x170 minimum: every timer appeared too
	// small to operate and had to be resized before use.
	await joinRoom(page, roomName('size'));
	await page.getByRole('button', { name: '+ timer' }).click();

	const frame = page.locator('.frame').first();
	const box = await frame.boundingBox();
	if (box === null) throw new Error('no box');
	// The camera scales the world, so compare in world units.
	const scale = await page
		.locator('.world')
		.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
	expect(box.width / scale).toBeGreaterThanOrEqual(190);
	expect(box.height / scale).toBeGreaterThanOrEqual(170);
});
