import { expect, test } from '@playwright/test';
import { hydrated } from './support/join';

/**
 * The account gate (AR-AUTH-7, UX-ROOM-11, UX-ID-4).
 *
 * The asymmetry these tests pin: making a room needs an account, joining one
 * never does. That is the whole of UX-ID-4, and it is the kind of rule someone
 * "fixes" into consistency if nothing asserts it.
 */

test('making a room requires an account', async ({ page }) => {
	await page.goto('/new');
	// The landing page routes Make a room through /new precisely so account
	// creation has ONE place to intercept.
	await expect(page).toHaveURL(/\/login\?next=%2Fnew|\/login\?next=\/new/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
});

test('the landing page still promises that joining is free', async ({ page }) => {
	await page.goto('/');
	await hydrated(page);
	// If this copy and the guard ever disagree, the copy is the lie people act
	// on — they follow an invitation and hit a signup wall.
	await expect(page.getByText(/no download, no account/i)).toBeVisible();
	// And the one prominent action still leads to the guarded route.
	await expect(page.getByRole('link', { name: 'Make a room' })).toHaveAttribute('href', /\/new/);
});

test('the sign-in page does not leak whether an account exists', async ({ page }) => {
	await page.goto('/login');
	await hydrated(page);
	await page.getByRole('textbox', { name: 'Email' }).fill('definitely-not-a-user@example.test');
	await page.getByRole('button', { name: /Email me a link/ }).click();
	// Same response either way: anything else turns the form into an
	// account-existence oracle.
	await expect(page.getByRole('status')).toContainText(/if that address can sign in/i);
});

test('signing out is POST-only, so a link cannot do it', async ({ request }) => {
	// A GET sign-out is CSRF-able and gets prefetched by browsers, which signs
	// people out by accident.
	const response = await request.get('/logout', { maxRedirects: 0 });
	expect(response.status()).toBe(405);
});
