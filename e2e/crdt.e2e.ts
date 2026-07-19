import { expect, test } from '@playwright/test';
import { SYNC, joinRoom, roomName } from './support/join';

/**
 * Concurrent note editing (UX-OBJ-2 / AR-SYNC-4). This is the test the whole
 * phase exists for: before it, note text was last-writer-wins on blur, so
 * whoever finished second silently erased the other person's work.
 */
test('crdt: two tabs typing in one note keep BOTH contributions', async ({ browser }) => {
	const room = roomName('crdt');
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await joinRoom(a, room);
	await a.getByRole('button', { name: '+ note' }).click();

	const editorA = a.getByRole('textbox', { name: 'Note text (markdown)' });
	await editorA.click();
	await editorA.pressSequentially('Alice writes. ');

	// B opens the same room and sees Alice's text.
	await joinRoom(b, room);
	const editorB = b.getByRole('textbox', { name: 'Note text (markdown)' });
	await expect(editorB).toHaveValue(/Alice writes\./, { timeout: SYNC });

	// Both type, neither having blurred. Under the old model the second blur
	// would have overwritten the first writer entirely.
	await editorB.click();
	await editorB.press('End');
	await editorB.pressSequentially('Bob adds.');

	await expect
		.poll(async () => editorA.inputValue(), { timeout: SYNC })
		.toContain('Bob adds.');

	const finalA = await editorA.inputValue();
	const finalB = await editorB.inputValue();
	expect(finalA).toContain('Alice writes.');
	expect(finalA).toContain('Bob adds.');
	// Convergence: both tabs agree on the same text, not just their own copy.
	expect(finalA).toBe(finalB);

	await context.close();
});

/**
 * The caret is carried across a peer's edit. A plain index would drift by
 * exactly the length of whatever the other person inserted before it, so your
 * next keystroke would land in the wrong place mid-sentence.
 */
test('crdt: a remote insert does not strand your caret', async ({ browser }) => {
	const room = roomName('caret');
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await joinRoom(a, room);
	await a.getByRole('button', { name: '+ note' }).click();

	const editorA = a.getByRole('textbox', { name: 'Note text (markdown)' });
	await editorA.click();
	await editorA.pressSequentially('END');

	await joinRoom(b, room);
	const editorB = b.getByRole('textbox', { name: 'Note text (markdown)' });
	await expect(editorB).toHaveValue('END', { timeout: SYNC });

	// A parks its caret at the very end and holds it there.
	await editorA.click();
	await editorA.press('End');

	// B inserts at the START, ahead of A's caret.
	await editorB.click();
	await editorB.press('Home');
	await editorB.pressSequentially('START ');
	await expect.poll(async () => editorA.inputValue(), { timeout: SYNC }).toContain('START ');

	// A keeps typing: its characters must still land at the end, not be
	// stranded six characters earlier where the old offset used to point.
	await editorA.pressSequentially('!');
	await expect.poll(async () => editorA.inputValue(), { timeout: SYNC }).toMatch(/END!$/);

	await context.close();
});
