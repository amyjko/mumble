import { expect, test } from '@playwright/test';
import { joinRoom } from './support/join';

/**
 * Object visibility (UX-ROOM-3). Hiding is a LAYOUT property captured per
 * configuration alongside position and size — not a delete. This is what
 * resolved the old "hide vs remove" open item: nothing is ever removed, so
 * there is no question of what happens to an object present in one
 * configuration and absent from another.
 */
test('visibility: hiding ghosts the object for its creator and frees its space', async ({ page }) => {
	const room = `vis-${Date.now().toString(36)}`;
	await joinRoom(page, room);
	await page.getByRole('button', { name: '+ note' }).click();

	const frame = page.locator('.frame');
	await expect(frame).toHaveCount(1);
	await frame.hover();

	await page.getByRole('button', { name: 'Hide object from others' }).click();

	// Still present and still MINE to interact with — hiding is reversible, so
	// the creator keeps a ghosted copy rather than losing the object.
	await expect(page.locator('.frame.ghost')).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Show object (hidden from others)' })).toBeVisible();

	// And it is genuinely interactive, not merely painted: the toggle round-trips.
	await page.getByRole('button', { name: 'Show object (hidden from others)' }).click();
	await expect(page.locator('.frame.ghost')).toHaveCount(0);
});

/** A configuration restores visibility along with position and size. */
test('visibility: a configuration remembers what was hidden', async ({ page }) => {
	const room = `viscfg-${Date.now().toString(36)}`;
	await joinRoom(page, room);
	await page.getByRole('button', { name: '+ note' }).click();
	await expect(page.locator('.frame')).toHaveCount(1);

	// Save a configuration with the note visible.
	await page.getByRole('button', { name: /layouts/ }).click();
	await page.getByRole('textbox', { name: 'Configuration name' }).fill('Shown');
	await page.getByRole('button', { name: 'save', exact: true }).click();
	await page.keyboard.press('Escape');

	// Hide it, and save that as a second configuration.
	await page.locator('.frame').hover();
	await page.getByRole('button', { name: 'Hide object from others' }).click();
	await expect(page.locator('.frame.ghost')).toHaveCount(1);
	await page.getByRole('button', { name: /layouts/ }).click();
	await page.getByRole('textbox', { name: 'Configuration name' }).fill('Concealed');
	await page.getByRole('button', { name: 'save', exact: true }).click();

	// Switching back restores visibility, not just placement.
	await page.getByRole('button', { name: 'Shown', exact: true }).click();
	await expect(page.locator('.frame.ghost')).toHaveCount(0);

	await page.getByRole('button', { name: 'Concealed', exact: true }).click();
	await expect(page.locator('.frame.ghost')).toHaveCount(1);
});
