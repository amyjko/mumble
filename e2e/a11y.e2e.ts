import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { joinRoom } from './support/join';

/**
 * UX-A11Y-1's automatable half (AR-STYLE-3): axe scans in BOTH themes, plus
 * the keyboard journey no scanner can check (UX-A11Y-2). Conventions that
 * only a human can audit live in STYLE.md's checklist.
 */

async function expectNoViolations(page: Page): Promise<void> {
	const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
	expect(
		results.violations.map((v) => `${v.id}: ${v.help} (${String(v.nodes.length)} nodes)`)
	).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
	test(`axe: landing + room are violation-free (${theme})`, async ({ page }) => {
		await page.addInitScript((t) => {
			localStorage.setItem('mumble:theme', t);
		}, theme);
		await page.goto('/');
		await expectNoViolations(page);

		await joinRoom(page, `axe-${theme}-${Date.now().toString(36)}`);
		await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();
		await page.getByRole('button', { name: '+ note' }).click();
		await expect(page.locator('textarea.note')).toHaveCount(1);
		await expectNoViolations(page);
	});
}

test('keyboard journey: create, move (solver-constrained), edit, delete', async ({ page }) => {
	await joinRoom(page, `kbd-${Date.now().toString(36)}`);

	// Create from the keyboard.
	await page.getByRole('button', { name: '+ note' }).focus();
	await page.keyboard.press('Enter');
	const frame = page.getByRole('group', { name: /note/i });
	await expect(frame).toBeVisible();

	// Focus the frame, arrow-move it; the transform must change.
	await frame.focus();
	const before = await frame.evaluate((el) => el.style.transform);
	for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
	await expect
		.poll(async () => frame.evaluate((el) => el.style.transform))
		.not.toBe(before);

	// Enter edits; Escape returns focus to the frame (no trap).
	await page.keyboard.press('Enter');
	await expect(page.locator('textarea.note')).toBeFocused();
	await page.keyboard.type('typed without a pointer');
	await page.keyboard.press('Escape');
	await expect(frame).toBeFocused();
	await expect(frame).toHaveAccessibleName(/typed without a pointer/);

	// Delete from the keyboard.
	await page.keyboard.press('Delete');
	await expect(page.getByRole('group', { name: /note/i })).toHaveCount(0);
});

test('auto-fit toggle receives clicks and refits (regression: canvas capture)', async ({ page }) => {
	await joinRoom(page, `fit-${Date.now().toString(36)}`);
	const canvas = page.getByRole('application', { name: 'Room canvas' });
	await expect(canvas).toBeVisible();
	const toggle = page.getByRole('button', { name: /auto-fit/ });
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');

	// Manual pan disengages the mode (UX-CANVAS-3) and the toggle SHOWS it.
	await canvas.hover({ position: { x: 200, y: 500 } });
	await page.mouse.down();
	await page.mouse.move(320, 560);
	await page.mouse.up();
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');

	// Clicking the toggle must actually work (it sits INSIDE the canvas; a
	// missing target-check once let the canvas capture the pointer and
	// swallow this click) — and re-engaging refits the camera.
	const world = page.locator('.world');
	const before = await world.evaluate((el) => el.style.transform);
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(async () => world.evaluate((el) => el.style.transform)).not.toBe(before);
});

test('tabbing to an off-screen object scrolls it into view', async ({ page }) => {
	await joinRoom(page, `reveal-${Date.now().toString(36)}`);
	const canvas = page.getByRole('application', { name: 'Room canvas' });
	await expect(canvas).toBeVisible();
	// Two notes, then zoom in so they can't both be on screen.
	await page.getByRole('button', { name: '+ note' }).click();
	await page.getByRole('button', { name: '+ note' }).click();
	await canvas.focus();
	for (let i = 0; i < 6; i++) await page.keyboard.press('+'); // zoom in, auto-fit off
	const world = page.locator('.world');
	const before = await world.evaluate((el) => el.style.transform);
	// Tab into the canvas objects; focusing an off-screen one pans the world.
	await page.keyboard.press('Tab');
	await page.keyboard.press('Tab');
	await expect.poll(async () => world.evaluate((el) => el.style.transform)).not.toBe(before);
});

test('theme persists across reload and applies pre-paint', async ({ page }) => {
	await page.goto('/');
	const toggle = page.getByRole('button', { name: /change theme/i });
	await toggle.click(); // system -> light
	await toggle.click(); // light -> dark
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
