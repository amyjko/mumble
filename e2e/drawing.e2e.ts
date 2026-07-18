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

/*
 * NOT tested here: that drawings are exempt from collision (UX-OBJ-12).
 *
 * An end-to-end version fights the camera rather than the rule — auto-fit
 * refits the moment the stroke is created, so screen coordinates shift out
 * from under any assertion about where the ink landed, and the self avatar
 * legitimately displaces a note placed at the same spot. Both make a green or
 * red result say more about the camera than about collision.
 *
 * The rule is asserted precisely where it is enforced, in the store:
 * memory-store.spec.ts "drawings are exempt from collision" covers a stroke
 * staying where drawn, a drawing moving onto content, and a drawing not
 * obstructing anything else.
 */

/**
 * Drawing ON TOP of an object (UX-OBJ-11). A stroke starting over a note used
 * to be swallowed entirely: the frame stops pointerdown to begin a drag, and
 * the canvas ignores events targeting a child. In draw mode the canvas is a
 * drawing surface and content is pointer-transparent, so ink can annotate the
 * thing it is about.
 */
test('drawing: a stroke can start on top of an object', async ({ page }) => {
	const room = `over-${Date.now().toString(36)}`;
	await page.goto(`/hey/${room}`);
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();

	await page.getByRole('button', { name: '+ note' }).click();
	const frame = page.locator('.frame');
	await expect(frame).toHaveCount(1);
	const note = await frame.boundingBox();
	expect(note).not.toBeNull();
	if (note === null) return;

	await page.getByRole('button', { name: /draw/ }).click();
	// Wait for draw mode to actually take effect rather than assuming the click
	// applied it synchronously: content only becomes pointer-transparent once
	// the class lands, and pressing before then still starts a drag.
	await expect(page.locator('.canvas.draw-mode')).toHaveCount(1);

	// Find a point ON the note that is not covered by floating chrome. The
	// toolbar overlays the canvas, and auto-fit can put a lone note underneath
	// it, so a fixed offset into the note is not reliably pressable.
	const start = await page.evaluate(() => {
		const frame = document.querySelector('.frame');
		if (!(frame instanceof HTMLElement)) return null;
		const box = frame.getBoundingClientRect();
		for (let fy = 0.9; fy >= 0.2; fy -= 0.1) {
			const py = box.top + box.height * fy;
			const px = box.left + box.width * 0.2;
			const hit = document.elementFromPoint(px, py);
			// Pointer-transparent content means the canvas itself answers here.
			if (hit instanceof HTMLElement && hit.classList.contains('canvas')) {
				return { x: px, y: py, width: box.width };
			}
		}
		return null;
	});
	expect(start).not.toBeNull();
	if (start === null) return;

	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(start.x + start.width * 0.5, start.y, { steps: 10 });
	await page.mouse.up();

	// A drawing was created, and the note was not dragged in the process.
	await expect(page.locator('svg.drawing')).toHaveCount(1);
	await expect(page.locator('.frame')).toHaveCount(2);
});
