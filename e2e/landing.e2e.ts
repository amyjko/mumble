import { expect, test } from '@playwright/test';

/**
 * The landing page. Its job is to make one claim and offer one action, so
 * these assert exactly that — not the copy, which will change.
 */

test('the page leads with its claim and one prominent action', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(
		'Communication is more than words.'
	);

	// ONE call to action. A landing page with two competing primary actions is
	// a landing page with none.
	const cta = page.getByRole('link', { name: 'Make a room' });
	await expect(cta).toBeVisible();
	await cta.click();
	await expect(page).toHaveURL(/\/new$/);
	await expect(page.getByRole('textbox', { name: 'Room name' })).toBeVisible();
});

test('the features are a list, not four paragraphs pretending to be one', async ({ page }) => {
	await page.goto('/');
	// Structure a screen reader can skim: a list, each item with its own
	// heading. This is the part most likely to be rebuilt as <div>s later.
	const items = page.getByRole('listitem');
	await expect(items).toHaveCount(4);
	await expect(page.getByRole('heading', { level: 3 })).toHaveCount(4);
});

test('a room link still works without passing through the landing page', async ({ page }) => {
	// The whole promise of the footer line: someone handed a link never sees
	// any of this. Moving the form to /new must not have put a step in front
	// of people who were invited.
	await page.goto('/hey/lci');
	await expect(page.getByText('No such room')).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Your name' })).toBeVisible();
});
