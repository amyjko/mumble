import { expect, test } from '@playwright/test';

/**
 * Avatars are canvas objects (UX-AV-1): resizable, rotatable, and reshapeable
 * like anything else on the canvas. They were previously pinned to a fixed
 * circle for no principled reason.
 */
test('avatar: resize and reshape your own, and it syncs', async ({ browser }) => {
	const room = `avatar-${Date.now().toString(36)}`;
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await a.goto(`/hey/${room}`);
	await expect(a.getByRole('application', { name: 'Room canvas' })).toBeVisible();
	const avatar = a.locator('.avatar');
	await expect(avatar).toHaveCount(1);
	await avatar.hover();

	// The same handle vocabulary objects have, named for what they act on.
	await expect(a.getByRole('button', { name: 'Resize avatar from se' })).toBeVisible();
	await expect(a.getByRole('button', { name: 'Rotate avatar' })).toBeVisible();

	// Reshape: circle -> ellipse, applied to the inner clip layer so the
	// handles survive (the trap ObjectFrame already hit).
	const shape = a.getByRole('button', { name: /^Change avatar shape/ });
	await shape.click();
	await expect(a.getByRole('button', { name: /^Change avatar shape \(currently ellipse/ })).toBeVisible();
	await expect
		.poll(async () => avatar.locator('.skin').evaluate((el) => getComputedStyle(el).clipPath))
		.toContain('ellipse');

	// Still reachable afterwards — not trapped in the new shape.
	await avatar.hover();
	await expect(a.getByRole('button', { name: 'Resize avatar from se' })).toBeVisible();

	// Shape is participant state, so a peer sees it.
	await b.goto(`/hey/${room}`);
	await expect
		.poll(async () => b.locator('.avatar .skin').first().evaluate((el) => getComputedStyle(el).clipPath))
		.toContain('ellipse');

	await context.close();
});

/*
 * NOT tested here: that a PEER gets no handles on your avatar. Two pages in one
 * browser context share localStorage, so they share an identity and there is
 * only ever one participant — the stub cannot represent two people in a way
 * Playwright can drive. Separate contexts would give separate identities but
 * would not share room state, since sync is BroadcastChannel + localStorage.
 *
 * The guarantee is covered where it is actually enforced, in the store:
 * memory-store.spec.ts "refuses to resize or reshape SOMEONE ELSE's avatar".
 */

/**
 * Reactions are a burst medium (UX-AV-4): clicking three times shows three
 * emoji. A single current-emote-per-participant model swallowed all but the
 * last, which made rapid reacting feel broken.
 */
test('avatar: multiple reactions float at once', async ({ page }) => {
	const room = `avatar-react-${Date.now().toString(36)}`;
	await page.goto(`/hey/${room}`);
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();

	await page.getByRole('button', { name: 'Celebrate' }).click();
	await page.getByRole('button', { name: 'Heart' }).click();
	await page.getByRole('button', { name: 'Laugh' }).click();

	await expect(page.locator('.avatar .float')).toHaveCount(3);
});

/** Persistent states must be legible across the room (UX-AV-5). */
test('avatar: raised hand and away are prominent badges', async ({ page }) => {
	const room = `avatar-badge-${Date.now().toString(36)}`;
	await page.goto(`/hey/${room}`);
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();

	await page.getByRole('button', { name: 'Raise hand' }).click();
	const hand = page.getByRole('img', { name: 'hand raised' });
	await expect(hand).toBeVisible();
	// Large enough to read at a glance, not a corner tick.
	const size = await hand.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
	expect(size).toBeGreaterThanOrEqual(28);

	await page.getByRole('button', { name: 'Step away' }).click();
	await expect(page.getByRole('img', { name: 'stepped away' })).toBeVisible();
});

/** Every emoji renders in the vendored Noto face, not the system set. */
test('avatar: emoji use the emoji font everywhere', async ({ page }) => {
	const room = `avatar-font-${Date.now().toString(36)}`;
	await page.goto(`/hey/${room}`);
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();
	await page.getByRole('button', { name: 'Celebrate' }).click();

	const fonts = await page.evaluate(() =>
		[...document.querySelectorAll('.emoji')].map((el) => getComputedStyle(el).fontFamily)
	);
	expect(fonts.length).toBeGreaterThan(0);
	for (const family of fonts) expect(family).toContain('Noto Color Emoji');
});
