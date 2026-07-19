import { expect, test } from '@playwright/test';
import { joinRoom, roomName } from './support/join';

/**
 * The clip lives on the inner .clip layer, not .frame: clip-path clips
 * hit-testing for all descendants, so applying it to the frame erased the
 * object's own handles and shape button and trapped it in that shape.
 */

/** Clip shapes (UX-OBJ-7): cycling reaches ellipse/polygon (a real clip-path). */
test('clip: cycling an object shape applies a clip-path and syncs', async ({ browser }) => {
	const room = roomName('clip');
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await joinRoom(a, room);
	await a.getByRole('button', { name: '+ note' }).click();
	const frameA = a.locator('.frame');
	await frameA.hover();

	const shapeBtn = a.getByRole('button', { name: /^Change shape/ });
	// rounded -> circle -> ellipse (a clip-path shape)
	await shapeBtn.click();
	await shapeBtn.click();
	await expect(a.getByRole('button', { name: /^Change shape \(currently ellipse/ })).toBeVisible();
	await expect
		.poll(async () => frameA.locator('.clip').evaluate((el) => getComputedStyle(el).clipPath))
		.toContain('ellipse');

	// Shape is shared state — B sees the clip too.
	await joinRoom(b, room);
	const frameB = b.locator('.frame');
	await expect(frameB).toHaveCount(1);
	await expect
		.poll(async () => frameB.locator('.clip').evaluate((el) => getComputedStyle(el).clipPath))
		.toContain('ellipse');

	await context.close();
});

/**
 * The sticker border must FOLLOW the clip, not just be clipped by it
 * (UX-OBJ-8). Clipping only the sticker layer left the content a rectangle, so
 * the white border appeared at the four cardinal extremes and vanished at the
 * diagonals, where the ellipse cut into the content instead of surrounding it.
 * Sampling all the way around is what distinguishes the two renderings — the
 * cardinal points looked correct even when it was broken.
 */
test('clip: the sticker border follows the silhouette all the way around', async ({ page }) => {
	const room = roomName('clipborder');
	await joinRoom(page, room);
	await page.getByRole('button', { name: '+ note' }).click();
	await page.locator('.frame').hover();

	const shapeBtn = page.getByRole('button', { name: /^Change shape/ });
	await shapeBtn.click(); // rounded -> circle
	await shapeBtn.click(); // circle  -> ellipse
	await expect(page.getByRole('button', { name: /^Change shape \(currently ellipse/ })).toBeVisible();

	// Walk the ellipse at 16 angles, sampling just inside its edge. Every
	// sample must land on the sticker layer; landing on .content means the
	// content reaches the silhouette edge and no border is drawn there.
	const hits = await page.evaluate(() => {
		const clip = document.querySelector('.clip');
		if (!(clip instanceof HTMLElement)) return null;
		const box = clip.getBoundingClientRect();
		const cx = box.left + box.width / 2;
		const cy = box.top + box.height / 2;
		const out: string[] = [];
		for (let i = 0; i < 16; i++) {
			const t = (i / 16) * Math.PI * 2;
			const px = cx + (box.width / 2) * Math.cos(t) * 0.93;
			const py = cy + (box.height / 2) * Math.sin(t) * 0.93;
			const el = document.elementFromPoint(px, py);
			out.push(el instanceof HTMLElement ? (el.className.split(' ')[0] ?? '?') : 'none');
		}
		return out;
	});

	expect(hits).not.toBeNull();
	expect(hits).toHaveLength(16);
	// Uniformly the sticker: no angle where content reaches the edge.
	expect(hits).toEqual(Array.from({ length: 16 }, () => 'clip'));
});

/**
 * The trap regression. With clip-path on .frame, an ellipse or polygon
 * silhouette clipped away every control that sits outside it — the corner
 * handles, the rotate grip, AND the shape button itself — so once you reached
 * ellipse there was no pointer route back out; only the `c` key escaped.
 * Every shape in the cycle must stay pointer-operable.
 */
test('clip: controls stay reachable in every shape (no trapped object)', async ({ page }) => {
	const room = roomName('cliptrap');
	await joinRoom(page, room);
	await page.getByRole('button', { name: '+ note' }).click();

	const frame = page.locator('.frame');
	await frame.hover();

	// Walk the whole cycle by POINTER, asserting each step actually landed.
	// If the control were clipped away, the click would time out here.
	for (const shape of ['circle', 'ellipse', 'polygon', 'rect']) {
		await page.getByRole('button', { name: /^Change shape/ }).click();
		await expect(page.getByRole('button', { name: new RegExp(`^Change shape \\(currently ${shape}`) })).toBeVisible();
	}

	// The corner handles and rotate grip must also survive the clip: they sit
	// outside the silhouette on every non-rect shape.
	await page.getByRole('button', { name: /^Change shape/ }).click(); // -> rounded
	await page.getByRole('button', { name: /^Change shape/ }).click(); // -> circle
	await page.getByRole('button', { name: /^Change shape/ }).click(); // -> ellipse
	await expect(page.getByRole('button', { name: /^Change shape \(currently ellipse/ })).toBeVisible();
	await frame.hover();
	await expect(page.getByRole('button', { name: 'Resize object from nw' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Rotate object' })).toBeVisible();
	// Clickable, not merely painted — hit-testing is what clip-path took away.
	await page.getByRole('button', { name: 'Resize object from se' }).click({ trial: true });
});
