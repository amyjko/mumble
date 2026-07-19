import { expect, test } from '@playwright/test';
import { joinRoom, roomName } from './support/join';

/** Chat object (UX-OBJ-3): a message posted in one page appears in another. */
test('chat: a message posted by A is retained and seen by B', async ({ browser }) => {
	const room = roomName('chat');
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await joinRoom(a, room);
	await a.getByRole('button', { name: '+ chat' }).click();
	await a.getByRole('textbox', { name: 'Message' }).fill('hello room');
	await a.getByRole('button', { name: 'Send message' }).click();
	await expect(a.locator('.chat .text')).toHaveText('hello room');

	await joinRoom(b, room);
	await expect(b.locator('.chat .text')).toHaveText('hello room');

	await context.close();
});
