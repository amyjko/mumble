import { expect, test } from '@playwright/test';
import { joinRoom, roomName } from './support/join';

/** Note markdown rendering (UX-OBJ-2): rendered when unfocused, raw when editing. */
test('markdown: a note renders when unfocused and edits raw on focus', async ({ page }) => {
	await joinRoom(page, roomName('md'));
	await page.getByRole('button', { name: '+ note' }).click();

	const ta = page.locator('textarea.note');
	await ta.click();
	await ta.fill('# Heading\n\n**bold** and `code`');
	// Blur to commit + switch to the rendered view.
	await page.getByRole('application', { name: 'Room canvas' }).click({ position: { x: 40, y: 500 } });

	const md = page.locator('.md');
	await expect(md.locator('h1')).toHaveText('Heading');
	await expect(md.locator('strong')).toHaveText('bold');
	await expect(md.locator('code')).toHaveText('code');

	// Clicking the body returns to raw editing (the textarea shows source).
	await page.locator('.note-body').click();
	await expect(ta).toBeFocused();
	await expect(ta).toHaveValue('# Heading\n\n**bold** and `code`');
});
