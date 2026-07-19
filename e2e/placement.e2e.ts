import { expect, test } from '@playwright/test';
import { joinRoom, roomName } from './support/join';

/**
 * Placement (UX-AV-2/9, AR-CTRL-4/6). Only the last resolution step existed
 * before — a participant arrived wherever the caller suggested and was nudged
 * to a legal spot. Newcomer placers and per-configuration memory are what make
 * "arriving never displaces anyone" and "you return where you were" true.
 *
 * Pointer gestures on placers are covered in unit and browser-mode tests, not
 * here: drags do not drive under Playwright (see untested-behaviors.e2e.ts).
 */

test('placement: a newcomer placer is labelled, numbered, and not an object', async ({ page }) => {
	await joinRoom(page, roomName('placer'));
	await page.getByRole('button', { name: '+ newcomer spot' }).click();

	// Labelled and numbered: the old design was an unexplained dashed circle,
	// which said nothing about what it was or who it was for.
	const placer = page.getByRole('group', { name: /Newcomer 1/ });
	await expect(placer).toBeVisible();

	// A second one numbers itself, rather than both claiming to be first.
	await page.getByRole('button', { name: '+ newcomer spot' }).click();
	await expect(page.getByRole('group', { name: /Newcomer 2/ })).toBeVisible();

	// It is a MARKER, not an object: no object frame appears for it, so none of
	// the object chrome or layout machinery applies.
	await expect(page.locator('.frame')).toHaveCount(0);

	// Rotatable and reshapeable like every other shape on the canvas, by
	// pointer as well as keyboard — a rotate/shape control that exists only as
	// a key binding is not discoverable.
	await placer.hover();
	// Scoped to THIS placer: two exist by now, so an unscoped role query is a
	// strict-mode violation rather than a check.
	await expect(placer.getByRole('button', { name: /Rotate placer/ })).toBeVisible();
	const shapeButton = page.getByRole('button', { name: /Change Newcomer 1 shape/ });
	await expect(shapeButton).toHaveAttribute('aria-label', /currently circle/);
	await shapeButton.click();
	await expect(shapeButton).not.toHaveAttribute('aria-label', /currently circle/);

	// Keyboard-movable like everything else on the canvas (UX-A11Y-2).
	const before = await placer.evaluate((el) => (el instanceof HTMLElement ? el.style.transform : ''));
	await placer.focus();
	await page.keyboard.press('ArrowRight');
	await expect
		.poll(async () => placer.evaluate((el) => (el instanceof HTMLElement ? el.style.transform : '')))
		.not.toBe(before);
});

test('placement: a selected placer keeps its controls when the pointer leaves', async ({ page }) => {
	// The regression this exists for: chrome sits OUTSIDE the box, so on a
	// hover-only reveal the pointer crosses dead space on its way to a button,
	// hover ends, and the control vanishes before it can be pressed. Every
	// earlier test hovered and clicked in one motion, so all of them passed
	// against the broken build.
	await joinRoom(page, roomName('select'));
	await page.getByRole('button', { name: '+ newcomer spot' }).click();

	const placer = page.getByRole('group', { name: /Newcomer 1/ });
	const box = await placer.boundingBox();
	if (box === null) throw new Error('placer has no box');

	// Click to select, then move the pointer far away.
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.move(5, 5);

	const shapeButton = page.getByRole('button', { name: /Change Newcomer 1 shape/ });
	await expect(shapeButton).toBeVisible();
	await shapeButton.click();
	await expect(shapeButton).not.toHaveAttribute('aria-label', /currently circle/);

	// Escape lets go, so selection is not a trap. The pointer has to leave
	// first: it is resting on the button after the click, and hover keeping the
	// chrome up while the pointer is on it is correct, not a leak.
	await page.keyboard.press('Escape');
	await page.mouse.move(5, 5);
	await expect(shapeButton).toHaveCount(0);
});

test('placement: the rotate grip is actually VISIBLE, not merely present', async ({ page }) => {
	// TransformHandles ships grips at opacity 0 and relies on the parent to
	// reveal them. This component lacked that rule, so the rotate control was
	// in the DOM, answered to the keyboard, and could not be seen — which every
	// role-based query reports as a pass.
	await joinRoom(page, roomName('grip'));
	await page.getByRole('button', { name: '+ newcomer spot' }).click();

	const placer = page.getByRole('group', { name: /Newcomer 1/ });
	const rotate = placer.getByRole('button', { name: /Rotate placer/ });
	await expect(rotate).toHaveCSS('opacity', '0');

	await placer.hover();
	await expect(rotate).toHaveCSS('opacity', '1');
});

test('placement: removing a placer renumbers the rest', async ({ page }) => {
	await joinRoom(page, roomName('renumber'));
	await page.getByRole('button', { name: '+ newcomer spot' }).click();
	await page.getByRole('button', { name: '+ newcomer spot' }).click();
	await expect(page.getByRole('group', { name: /Newcomer 2/ })).toBeVisible();

	// Hover first: a placer rests below avatars, and hovering raises it so its
	// controls are reachable even when someone is standing in it.
	await page.getByRole('group', { name: /Newcomer 1/ }).hover();
	await page.getByRole('button', { name: 'Remove Newcomer 1' }).click();

	// What was 2 becomes 1: a "Newcomer 2" with no Newcomer 1 is a puzzle.
	await expect(page.getByRole('group', { name: /Newcomer 1/ })).toBeVisible();
	await expect(page.getByRole('group', { name: /Newcomer 2/ })).toHaveCount(0);
});

test('placement: you return to where you were, per configuration', async ({ page }) => {
	const room = roomName('remember');
	await joinRoom(page, room);

	const avatar = page.locator('.avatar');
	await avatar.focus();
	for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
	// The keyboard move commits on a debounce; let it land.
	await page.waitForTimeout(400);
	const moved = await avatar.evaluate((el) => (el instanceof HTMLElement ? el.style.transform : ''));

	await page.reload();
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();

	// Rejoining puts you back where you were, rather than in a newcomer spot.
	await expect
		.poll(async () =>
			page.locator('.avatar').evaluate((el) => (el instanceof HTMLElement ? el.style.transform : ''))
		)
		.toBe(moved);
});
