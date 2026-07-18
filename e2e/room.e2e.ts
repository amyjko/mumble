import { expect, test } from '@playwright/test';

/**
 * The page-level guard (AR-TEST-9's first slice): runs against the BUILT
 * worker in workerd (playwright.config webServer = build + preview), driving
 * the real room page. Exists because three reactivity bugs in a row lived at
 * page wiring level — below E2E, above component tests — where nothing else
 * looks: $derived construction crashes, effect read-write loops, dispose
 * races. Any pageerror fails the test, so that whole class is caught here.
 */

test('two pages share a room: create in A, see in B, no page errors', async ({ browser }) => {
	const room = `e2e-${Date.now().toString(36)}`;
	const context = await browser.newContext();
	const errors: string[] = [];

	const pageA = await context.newPage();
	const pageB = await context.newPage();
	for (const page of [pageA, pageB]) {
		page.on('pageerror', (error) => {
			errors.push(error.message);
		});
	}

	// A joins; the join effect must settle (one avatar, no loop).
	await pageA.goto(`/hey/${room}`);
	await expect(pageA.getByRole('application', { name: 'Room canvas' })).toBeVisible();
	await expect(pageA.locator('.avatar')).toHaveCount(1);

	// B joins the same room in the same context (same identity, same avatar).
	await pageB.goto(`/hey/${room}`);
	await expect(pageB.getByRole('application', { name: 'Room canvas' })).toBeVisible();

	// A creates a note AFTER B is up — so B seeing it proves live
	// BroadcastChannel sync, not just localStorage hydration.
	await pageA.getByRole('application', { name: 'Room canvas' }).dblclick({ position: { x: 400, y: 400 } });
	await expect(pageA.locator('textarea.note')).toHaveCount(1);
	await expect(pageB.locator('textarea.note')).toHaveCount(1);

	// Text syncs on blur-commit.
	await pageA.locator('textarea.note').fill('hello from A');
	await pageA.getByRole('application', { name: 'Room canvas' }).click({ position: { x: 40, y: 500 } });
	await expect(pageB.locator('textarea.note')).toHaveValue('hello from A');

	// The whole session produced zero uncaught errors — the loop/crash guard.
	expect(errors).toEqual([]);
	await context.close();
});
