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
