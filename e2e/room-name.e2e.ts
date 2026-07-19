import { expect, test } from '@playwright/test';
import { joinRoom, roomName } from './support/join';

/**
 * Room names (UX-ROOM-9/10). The pattern used to exist in two places with each
 * caller separately remembering to lowercase; the reserved list required by
 * UX-ROOM-9 did not exist at all, and UX-ROOM-10's "hosts are warned before
 * renaming" was missing without even a comment admitting it.
 */

test('a reserved name is not a room', async ({ page }) => {
	// From outside, an unclaimable name and a nonexistent room are the same
	// thing, so this errors exactly as a malformed name does.
	//
	// Asserted on what the user SEES, not on the HTTP status: the route is
	// ssr=false, so the shell always returns 200 and the 404 is produced by the
	// client-side load. A status assertion would pass on a broken page.
	await page.goto('/hey/admin');
	await expect(page.getByText('No such room')).toBeVisible();
});

test('a malformed name is refused the same way', async ({ page }) => {
	await page.goto('/hey/a');
	await expect(page.getByText('No such room')).toBeVisible();
});

test('a well-formed name still resolves', async ({ page }) => {
	// Guards the negative cases above: if every route errored, they would pass
	// while proving nothing.
	await joinRoom(page, roomName('ok'));
	await expect(page.getByText('No such room')).toHaveCount(0);
});

test('the naming form explains WHY a name is rejected', async ({ page }) => {
	// The form moved off the landing page to /new, where account creation will
	// intercept once auth exists.
	await page.goto('/new');
	const field = page.getByRole('textbox', { name: 'Room name' });
	const go = page.getByRole('button', { name: 'go' });

	await field.fill('admin');
	await expect(page.getByRole('alert')).toContainText(/reserved/i);
	await expect(go).toBeDisabled();

	await field.fill('a');
	await expect(page.getByRole('alert')).toContainText(/2–32/);
	await expect(go).toBeDisabled();

	await field.fill('stand-up');
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(go).toBeEnabled();
});

test('case-insensitive: LCI reaches the same room as lci', async ({ page }) => {
	await page.goto('/new');
	await page.getByRole('textbox', { name: 'Room name' }).fill('LCI');
	await page.getByRole('button', { name: 'go' }).click();
	await expect(page).toHaveURL(/\/hey\/lci$/);
});

test('rename warns that existing links will break (UX-ROOM-10)', async ({ page }) => {
	const room = roomName('rn');
	await joinRoom(page, room);

	await page.getByRole('button', { name: room }).click();
	const field = page.getByRole('textbox', { name: 'New room name' });
	const rename = page.getByRole('button', { name: 'rename' });

	// A reserved target is refused with a reason, not silently ignored.
	await field.fill('admin');
	await expect(page.getByRole('alert')).toContainText(/reserved/i);
	await expect(rename).toBeDisabled();

	// A valid target warns before acting, and declining leaves the room alone.
	const target = `${room}-2`;
	await field.fill(target);
	await expect(rename).toBeEnabled();

	let warned = '';
	page.once('dialog', (dialog) => {
		warned = dialog.message();
		void dialog.dismiss();
	});
	await rename.click();
	expect(warned).toContain('lose access');
	await expect(page).toHaveURL(new RegExp(`/hey/${room}$`));

	// Accepting it goes through.
	page.once('dialog', (dialog) => void dialog.accept());
	await rename.click();
	await expect(page).toHaveURL(new RegExp(`/hey/${target}$`));
});
