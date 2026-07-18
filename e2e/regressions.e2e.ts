import { expect, test } from '@playwright/test';

/**
 * Fixes for bugs found by auditing DESIGN.md against the code rather than
 * against its checkboxes. Each test fails on the behavior that shipped.
 */

/**
 * Delete affordances were hard-coded to "note" for every object type, 400
 * lines below a carefully type-aware accessible name — so a screen-reader user
 * deleting a timer heard "Delete note", then "Note deleted" (UX-A11Y-3).
 */
test('a11y: delete names the object type, not always "note"', async ({ page }) => {
	const room = `noun-${Date.now().toString(36)}`;
	await page.goto(`/hey/${room}`);
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();

	await page.getByRole('button', { name: '+ timer' }).click();
	await page.locator('.frame').hover();
	await expect(page.getByRole('button', { name: 'Delete timer' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Delete note' })).toHaveCount(0);

	await page.getByRole('button', { name: '+ chat' }).click();
	await page.locator('.frame').last().hover();
	await expect(page.getByRole('button', { name: 'Delete chat' })).toBeVisible();
});

/**
 * Auto-zoom framed every participant as AVATAR_SIZE even after avatars became
 * resizable, so anyone scaled up was cropped. The collision path was corrected
 * when resize landed; this one was missed.
 */
test('auto-fit frames a resized avatar instead of cropping it', async ({ page }) => {
	const room = `fit-${Date.now().toString(36)}`;
	await page.goto(`/hey/${room}`);
	const canvas = page.getByRole('application', { name: 'Room canvas' });
	await expect(canvas).toBeVisible();

	// Grow the avatar well beyond the 96px default by dragging its se handle.
	// NOT by keyboard: avatars have arrow-move only and no Alt+Arrow resize —
	// a real UX-A11Y-2 gap, tracked separately, and the reason this test uses
	// the pointer.
	const avatar = page.locator('.avatar');
	await avatar.hover();
	const handle = page.getByRole('button', { name: 'Resize avatar from se' });
	await expect(handle).toBeVisible();
	const grip = await handle.boundingBox();
	expect(grip).not.toBeNull();
	if (grip === null) return;
	await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
	await page.mouse.down();
	await page.mouse.move(grip.x + 220, grip.y + 220, { steps: 12 });
	await page.mouse.up();
	await page.waitForTimeout(300);

	// Re-engage auto-fit ('0' is the canvas shortcut) and let it settle.
	await canvas.focus();
	await page.keyboard.press('0');
	await page.waitForTimeout(500);

	// Assert CENTERING, not merely "on screen". fitAll caps scale at 1, so a
	// lone avatar is never zoomed — only centered — and an undersized bounds
	// estimate still leaves it fully visible. What it does NOT do is centre it:
	// framing a 300px avatar as 96px centres the wrong box, pushing the real
	// avatar off-centre by roughly half the difference. An "is it on screen"
	// assertion passes on the bug; this one does not.
	const framed = await page.evaluate(() => {
		const el = document.querySelector('.avatar');
		const view = document.querySelector('.canvas');
		if (!(el instanceof HTMLElement) || !(view instanceof HTMLElement)) return null;
		const a = el.getBoundingClientRect();
		const c = view.getBoundingClientRect();
		return {
			offsetX: Math.abs(a.left + a.width / 2 - (c.left + c.width / 2)),
			offsetY: Math.abs(a.top + a.height / 2 - (c.top + c.height / 2)),
			width: Math.round(a.width)
		};
	});
	expect(framed).not.toBeNull();
	// It actually grew — otherwise the centring assertion proves nothing.
	expect(framed?.width ?? 0).toBeGreaterThan(200);
	expect(framed?.offsetX ?? 999).toBeLessThan(20);
	expect(framed?.offsetY ?? 999).toBeLessThan(20);
});

/**
 * UX-ROOM-5's reset restores the ACTIVE configuration's layout, so with none
 * saved it can do nothing. It used to be offered anyway and silently no-op.
 */
test('reset is disabled until a configuration exists', async ({ page }) => {
	const room = `reset-${Date.now().toString(36)}`;
	await page.goto(`/hey/${room}`);
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();

	await page.getByRole('button', { name: /configs/ }).click();
	const reset = page.getByRole('button', { name: /reset layout/ });
	await expect(reset).toBeDisabled();

	// Save one, and it becomes available.
	await page.getByRole('textbox', { name: 'Configuration name' }).fill('Start');
	await page.getByRole('button', { name: 'save', exact: true }).click();
	await expect(reset).toBeEnabled();
});
