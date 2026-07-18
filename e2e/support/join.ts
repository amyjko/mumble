import { expect, type Page } from '@playwright/test';

/**
 * Enter a room, answering the join prompt if it appears.
 *
 * UX-ID-1 requires a name before joining, so every room visit now starts with
 * a prompt on a fresh browser. Identity is stored per browser context, so only
 * the first page in a context sees it — which is why this checks rather than
 * assuming, and why it works unchanged for the many two-page tests where the
 * second page inherits the first's identity.
 *
 * Centralised deliberately: a per-test copy of this would be ~20 copies of a
 * rule that is going to keep changing.
 */
export async function joinRoom(page: Page, room: string, name = 'Tester'): Promise<void> {
	await page.goto(`/hey/${room}`);

	const nameField = page.getByRole('textbox', { name: 'Your name' });
	const canvas = page.getByRole('application', { name: 'Room canvas' });

	// Wait for ONE of the two outcomes before deciding which happened.
	// `isVisible()` does not wait, so checking it directly is a race: under
	// parallel workers the check ran before the dialog rendered, the prompt
	// went unanswered, and the canvas never appeared. Sequentially it passed
	// every time, which is exactly how this kind of flake hides.
	await expect(nameField.or(canvas).first()).toBeVisible();

	if (await nameField.isVisible()) {
		await nameField.fill(name);
		await page.getByRole('button', { name: 'Join' }).click();
	}

	await expect(canvas).toBeVisible();
}

/** A room name unique to this test run. */
export function roomName(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
}
