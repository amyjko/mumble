import { expect, test } from '@playwright/test';

/** Chat object (UX-OBJ-3): a message posted in one page appears in another. */
test('chat: a message posted by A is retained and seen by B', async ({ browser }) => {
	const room = `chat-${Date.now().toString(36)}`;
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await a.goto(`/hey/${room}`);
	await expect(a.getByRole('application', { name: 'Room canvas' })).toBeVisible();
	await a.getByRole('button', { name: '+ chat' }).click();
	await a.getByRole('textbox', { name: 'Message' }).fill('hello room');
	await a.getByRole('button', { name: 'Send message' }).click();
	await expect(a.locator('.chat .text')).toHaveText('hello room');

	await b.goto(`/hey/${room}`);
	await expect(b.locator('.chat .text')).toHaveText('hello room');

	await context.close();
});
