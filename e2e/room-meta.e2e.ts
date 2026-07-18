import { expect, test } from '@playwright/test';

/** Room title (UX-ROOM-2) syncs; rename (UX-ROOM-10) navigates carrying state. */
test('title syncs to peers; rename navigates and carries state', async ({ browser }) => {
	const room = `meta-${Date.now().toString(36)}`;
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await a.goto(`/hey/${room}`);
	await expect(a.getByRole('application', { name: 'Room canvas' })).toBeVisible();
	await a.getByRole('button', { name: '+ note' }).click(); // some state to carry

	// Set a title via the room popover.
	await a.getByText(room, { exact: true }).click();
	await a.getByRole('textbox', { name: 'Room title' }).fill('Design Sync');
	await a.getByRole('textbox', { name: 'Room title' }).blur();

	// B sees the title.
	await b.goto(`/hey/${room}`);
	await expect(b.getByText('Design Sync')).toBeVisible();

	// Rename → new URL, and the note came along.
	const newName = `${room}-2`;
	await a.getByRole('textbox', { name: 'New room name' }).fill(newName);
	// Renaming now warns first (UX-ROOM-10: existing links break). Playwright
	// auto-dismisses dialogs, so the rename would silently not happen.
	a.once('dialog', (dialog) => void dialog.accept());
	await a.getByRole('button', { name: 'rename' }).click();
	await expect(a).toHaveURL(new RegExp(`/hey/${newName}$`));
	await expect(a.locator('.frame')).toHaveCount(1); // state carried

	await context.close();
});
