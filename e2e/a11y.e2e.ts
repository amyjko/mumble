import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { hydrated, joinRoom, roomName } from './support/join';

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
	test(`axe: landing + new + room are violation-free (${theme})`, async ({ page }) => {
		await page.addInitScript((t) => {
			localStorage.setItem('mumble:theme', t);
		}, theme);
		await page.goto('/');
		await expectNoViolations(page);

		// The naming form is its own route now, and an unscanned route is an
		// unscanned route however small it is.
		await page.goto('/new');
		await expectNoViolations(page);

		await joinRoom(page, roomName(`axe-${theme}`));
		await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();
		await page.getByRole('button', { name: '+ note' }).click();
		await expect(page.locator('textarea.note')).toHaveCount(1);
		await expectNoViolations(page);
	});
}

test('keyboard journey: create, move (solver-constrained), edit, delete', async ({ page }) => {
	await joinRoom(page, roomName('kbd'));

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
	await joinRoom(page, roomName('fit'));
	const canvas = page.getByRole('application', { name: 'Room canvas' });
	await expect(canvas).toBeVisible();
	// The camera controls moved into the single bottom toolbar (BottomBar).
	const toggle = page.getByRole('button', { name: /Auto-fit/ });
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');

	// Manual pan disengages the mode (UX-CANVAS-3) and the toggle SHOWS it.
	await canvas.hover({ position: { x: 200, y: 500 } });
	await page.mouse.down();
	await page.mouse.move(320, 560);
	await page.mouse.up();
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');

	// Clicking the toggle must actually work — a missing target-check once let
	// the canvas capture the pointer and swallow this click — and re-engaging
	// refits the camera.
	const world = page.locator('.world');
	const before = await world.evaluate((el) => el.style.transform);
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(async () => world.evaluate((el) => el.style.transform)).not.toBe(before);
});

test('tabbing to an off-screen object scrolls it into view', async ({ page }) => {
	await joinRoom(page, roomName('reveal'));
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
	// The control is server-rendered before its handler exists; clicking in
	// that window does nothing and reads as a failed toggle.
	await hydrated(page);
	const toggle = page.getByRole('button', { name: /change theme/i });
	// Confirm each step before taking the next. Two clicks in a row race under
	// parallel load: the second can land before the first has been applied, and
	// the cycle ends on light instead of dark.
	await toggle.click(); // system -> light
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await toggle.click(); // light -> dark
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

/**
 * UX-A11Y-2 requires that everything the pointer does can be done from the
 * keyboard. Avatars gained pointer resize/rotate/reshape when they became
 * canvas objects and the keyboard was left behind, so those three were
 * pointer-only — exactly the gap the requirement forbids.
 */
test('keyboard: an avatar can be resized, rotated and reshaped without a pointer', async ({ page }) => {
	await joinRoom(page, roomName('kbdav'));
	const avatar = page.locator('.avatar');
	await avatar.focus();

	const before = await avatar.evaluate((el) => ({
		w: Math.round(el.getBoundingClientRect().width),
		transform: el.style.transform
	}));

	for (let i = 0; i < 4; i++) await page.keyboard.press('Alt+ArrowRight');
	await expect
		.poll(async () => avatar.evaluate((el) => Math.round(el.getBoundingClientRect().width)))
		.toBeGreaterThan(before.w);

	await page.keyboard.press(']');
	await expect.poll(async () => avatar.evaluate((el) => el.style.transform)).toContain('rotate(15deg)');

	// `c` cycles the clip, same key objects use.
	await page.keyboard.press('c');
	await expect(page.getByRole('button', { name: /^Change avatar shape \(currently ellipse/ })).toBeVisible();
});

/**
 * Remote changes were silent (UX-A11Y-3): only your own creations and
 * deletions were announced, so a screen-reader user could not tell the room
 * was changing around them.
 */
test('announcements: another person adding an object is announced', async ({ browser }) => {
	// TWO CONTEXTS — two genuinely different people.
	//
	// This used to be one context with a second identity written straight into
	// localStorage, because the stub synced over BroadcastChannel and
	// localStorage and neither crosses a context. That constraint is gone: the
	// server syncs across contexts, and a context is now exactly one
	// authenticated session. Keeping the old device would silently test the
	// opposite of what it claims — both pages would share one auth user, so
	// "Bo's" note would carry Amy's creator id and Amy would correctly stay
	// silent about her own change.
	const room = roomName('ann');
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const pa = await ctxA.newPage();
	const pb = await ctxB.newPage();

	await joinRoom(pa, room, 'Amy');
	await joinRoom(pb, room, 'Bo');

	// Bo adds a note; Amy's live region must say so.
	//
	// Asserted WITHOUT the name: the announcement degrades to "Someone" if
	// Amy's snapshot has not yet caught Bo's participant record, and pinning
	// the name would be asserting against sync timing rather than against this
	// feature.
	await pb.getByRole('button', { name: '+ note' }).click();
	await expect(pa.locator('.sr-only[aria-live]')).toContainText(/added a note/i, { timeout: 10_000 });

	await ctxA.close();
	await ctxB.close();
});
