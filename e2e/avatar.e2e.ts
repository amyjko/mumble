import { expect, test } from '@playwright/test';
import { joinRoom, roomName } from './support/join';

/**
 * Avatars are canvas objects (UX-AV-1): resizable, rotatable, and reshapeable
 * like anything else on the canvas. They were previously pinned to a fixed
 * circle for no principled reason.
 */
test('avatar: resize and reshape your own, and it syncs', async ({ browser }) => {
	const room = roomName('avatar');
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await joinRoom(a, room);
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
	await joinRoom(b, room);
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
	const room = roomName('avatar-react');
	await joinRoom(page, room);

	await page.getByRole('button', { name: 'Celebrate' }).click();
	await page.getByRole('button', { name: 'Heart' }).click();
	await page.getByRole('button', { name: 'Laugh' }).click();

	await expect(page.locator('.avatar .float')).toHaveCount(3);
});

/** Persistent states must be legible across the room (UX-AV-5). */
test('avatar: raised hand and away are prominent badges', async ({ page }) => {
	const room = roomName('avatar-badge');
	await joinRoom(page, room);

	// The room has to be CONTENDED for a raised hand to exist at all: raising
	// is queueing (UX-AV-6), and with a slot free you are promoted into it
	// immediately rather than left waiting. So remove every slot first.
	await page.getByRole('button', { name: /^stage/ }).click();
	for (const field of ['Video slots', 'Audio slots']) {
		await page.getByRole('textbox', { name: field }).fill('0');
		await page.getByRole('textbox', { name: field }).blur();
	}
	await page.keyboard.press('Escape');

	await page.getByRole('button', { name: 'Raise hand to queue' }).click();
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
	const room = roomName('avatar-font');
	await joinRoom(page, room);
	await page.getByRole('button', { name: 'Celebrate' }).click();

	const fonts = await page.evaluate(() =>
		[...document.querySelectorAll('.emoji')].map((el) => getComputedStyle(el).fontFamily)
	);
	expect(fonts.length).toBeGreaterThan(0);
	for (const family of fonts) expect(family).toContain('Noto Color Emoji');
});

/**
 * The avatar's face must actually be VISIBLE, not merely present.
 *
 * The sticker layer is absolutely positioned and so paints above static
 * siblings regardless of DOM order; it covered the face completely, leaving a
 * blank white circle. Every DOM-level check passed while it was broken — the
 * element existed, had a bounding box, and even answered elementFromPoint,
 * because the covering layer sets pointer-events: none and hit-testing
 * therefore skips it.
 *
 * So this asserts on PIXELS: the face region must not be uniformly the sticker
 * colour. Nothing cheaper would have caught it.
 */
test('avatar: the face is actually painted, not covered by the sticker', async ({ page }) => {
	await joinRoom(page, roomName('face'), 'Amy');

	const face = page.locator('.avatar .face');
	await expect(face).toBeVisible();

	const shot = await face.screenshot();
	// A PNG of a single flat colour compresses to almost nothing; a rendered
	// emoji does not. This is a deliberately crude signal, chosen because it
	// cannot be fooled by the DOM being right while the paint is wrong.
	expect(shot.byteLength).toBeGreaterThan(400);

});

