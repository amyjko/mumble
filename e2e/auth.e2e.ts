import { expect, test } from '@playwright/test';
import { hydrated } from './support/join';
import { adminClient, testEmail } from './support/auth';
import { z } from 'zod';

/** Mailpit, the local SMTP catcher the Supabase CLI runs (config.toml [local_smtp]). */
const MAILPIT = 'http://127.0.0.1:54324';

/** Mailpit's API, only as far as this test reads it. */
const searchResult = z.object({ messages: z.array(z.object({ ID: z.string() })) });
const mailBody = z.object({ Text: z.string(), HTML: z.string() });

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

/**
 * The one test that goes through the SMTP catcher (AR-TEST-8).
 *
 * Everything else in this suite signs in with `generateLink`, which mints a
 * token without ever sending mail — deliberately, because scraping an inbox for
 * every sign-in would be slow and fragile. But that leaves the email path
 * itself completely unexercised: `signInWithOtp` is a different call, and the
 * only thing that proves it produces a usable link is reading the mail.
 *
 * What this actually pins is OURS, not Supabase's. The subject and body are
 * GoTrue's stock template; the LINK is shaped by the `emailRedirectTo` this app
 * passes and comes back to a route this app owns. So the assertions are: the
 * mail arrives, its link redirects to /auth/confirm, and following the whole
 * chain signs the person in. A test that stopped at "an email arrived" would
 * pass against a link that goes nowhere — which is exactly what this found.
 */
test('the magic-link email carries a link that actually signs you in', async ({ page }) => {
	const email = testEmail('mailpit');
	// A real account, so the link is a MAGICLINK rather than a signup
	// confirmation wearing its name — the distinction that support/auth.ts
	// already documents, and it changes which token type comes back.
	await adminClient().auth.admin.createUser({ email, email_confirm: true });

	await page.goto('/login');
	await hydrated(page);
	await page.getByRole('textbox', { name: 'Email' }).fill(email);
	await page.getByRole('button', { name: /Email me a link/ }).click();
	await expect(page.getByRole('status')).toContainText(/if that address can sign in/i);

	// Mailpit accepts a search query, so this never depends on the inbox being
	// empty — the suite shares one catcher and other tests send mail too. The
	// address is unique per run, so exactly one message can match.
	let messageId = '';
	await expect
		.poll(
			async () => {
				const found = await page.request.get(
					`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`
				);
				if (!found.ok()) return '';
				// Parsed, not asserted: `as` is banned here, and a foreign
				// inbox API is exactly the sort of JSON a schema should meet.
				const body = searchResult.safeParse(await found.json());
				messageId = body.success ? (body.data.messages[0]?.ID ?? '') : '';
				return messageId;
			},
			{ timeout: 15_000 }
		)
		.not.toBe('');

	const full = await page.request.get(`${MAILPIT}/api/v1/message/${messageId}`);
	const mail = mailBody.parse(await full.json());

	// The link is the payload. Read it out of the mail rather than constructing
	// it, because constructing it is what every other test does and is exactly
	// the shortcut that hid the bug below.
	const href = /https?:\/\/[^\s"'<>)]+/.exec(`${mail.Text}\n${mail.HTML}`)?.[0];
	if (href === undefined) throw new Error('the magic-link email contained no link at all');
	const link = new URL(href.replaceAll('&amp;', '&'));

	/*
	 * The link goes to GoTrue's own /auth/v1/verify, which consumes the token
	 * and 302s to `redirect_to`. So the thing to assert is that `redirect_to`
	 * is OURS — that is the half this app controls, via the `emailRedirectTo`
	 * the login action passes.
	 *
	 * This assertion is why the test exists. It failed the first time it ran:
	 * `redirect_to` was http://127.0.0.1:3000 — the stock site_url, which this
	 * project does not serve — because the app's own origin was missing from
	 * `additional_redirect_urls`, and GoTrue discards a redirect it does not
	 * recognise instead of erroring. Local magic-link sign-in was broken and
	 * invisible, because every other test hands itself a token hash and never
	 * asks GoTrue to honour a redirect.
	 */
	expect(link.pathname).toBe('/auth/v1/verify');
	const redirect = new URL(link.searchParams.get('redirect_to') ?? '');
	expect(redirect.pathname).toBe('/auth/confirm');

	// And following the whole chain signs you in — asserted by reaching the
	// account-gated route that `making a room requires an account` proves is
	// closed to everyone else.
	await page.goto(link.toString());
	await page.goto('/new');
	await expect(page.getByRole('textbox', { name: 'Room name' })).toBeVisible();
});

test('signing out is POST-only, so a link cannot do it', async ({ request }) => {
	// A GET sign-out is CSRF-able and gets prefetched by browsers, which signs
	// people out by accident.
	const response = await request.get('/logout', { maxRedirects: 0 });
	expect(response.status()).toBe(405);
});
