import { expect, test } from '@playwright/test';
import { SYNC, joinRoom, roomName } from './support/join';
import { hostRoom } from './support/auth';

/** Room title (UX-ROOM-2) syncs; rename (UX-ROOM-10) navigates carrying state. */
test('title syncs to peers; rename navigates and carries state', async ({ browser }) => {
	const room = roomName('meta');
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	// A HOSTS, because renaming is a host action and the server enforces it now
	// (UX-ROOM-10). As a guest this test renamed nothing and only appeared to
	// pass, because the stub's rename was a localStorage copy.
	await hostRoom(a, room);
	await a.getByRole('button', { name: '+ note' }).click(); // some state to carry

	// Set a title via the room popover.
	await a.getByText(room, { exact: true }).click();
	await a.getByRole('textbox', { name: 'Room title' }).fill('Design Sync');
	await a.getByRole('textbox', { name: 'Room title' }).blur();

	// B sees the title.
	await joinRoom(b, room);
	await expect(b.getByText('Design Sync')).toBeVisible({ timeout: SYNC });

	// Rename → new URL, and the note came along.
	const newName = `${room}-2`;
	await a.getByRole('textbox', { name: 'New room name' }).fill(newName);
	// Renaming now warns first (UX-ROOM-10: existing links break). Playwright
	// auto-dismisses dialogs, so the rename would silently not happen.
	a.once('dialog', (dialog) => void dialog.accept());
	await a.getByRole('button', { name: 'rename' }).click();
	await expect(a).toHaveURL(new RegExp(`/${newName}$`));
	await expect(a.locator('.frame')).toHaveCount(1); // state carried

	await context.close();
});
