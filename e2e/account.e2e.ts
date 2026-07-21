import { expect, test } from '@playwright/test';
import { z } from 'zod';
import { hydrated, joinRoom, roomName } from './support/join';
import { adminClient, signInAsAccount, testEmail } from './support/auth';

/**
 * The account page (UX-ID-10, UX-ECON-2).
 *
 * Two things it must get right, and they fail in opposite directions:
 *
 *  - the BUDGET must be the same number the room toolbar shows, rolled. A page
 *    reporting a spent week after the week has turned would be the one surface
 *    still lying about a budget that had already reset.
 *  - the EMAIL CHANGE must not claim to have happened. With double-confirm on,
 *    the address moves only when BOTH inboxes confirm, so a success message
 *    saying "changed" is a lie that comes true only if the person checks two.
 */

/** Mailpit, the local SMTP catcher the Supabase CLI runs (config.toml [local_smtp]). */
const MAILPIT = 'http://127.0.0.1:54324';
const searchResult = z.object({ messages: z.array(z.object({ ID: z.string() })) });
const mailBody = z.object({ Text: z.string(), HTML: z.string() });

test('signing in is required to see an account', async ({ page }) => {
	await page.goto('/account');
	await expect(page).toHaveURL(/\/login\?next=%2Faccount|\/login\?next=\/account/);
});

test('the account page shows the weekly budget and the sign-in address', async ({ page }) => {
	const email = testEmail('account');
	const userId = await signInAsAccount(page, email);

	// Six hours used of ten, set directly rather than metered — the same trick
	// the budget tests use, and for the same reason: the numbers are what is
	// under test, not the clock.
	const { error } = await adminClient()
		.from('accounts')
		.update({ weekly_seconds_used: 6 * 3600, weekly_cap_seconds: 10 * 3600 })
		.eq('id', userId);
	if (error !== null) throw new Error(`could not set the budget: ${error.message}`);

	await page.goto('/account');
	await hydrated(page);

	await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
	// The headline figure, and the two numbers it is derived from — so a page
	// that showed "4h" while the cap said something incompatible would fail.
	await expect(page.getByText('4h left this week')).toBeVisible();
	await expect(page.getByText('Weekly budget')).toBeVisible();
	await expect(page.getByRole('definition').filter({ hasText: '10h' })).toBeVisible();
	await expect(page.getByRole('definition').filter({ hasText: '6h' })).toBeVisible();

	// The address comes from the verified token, so this also pins that the
	// page is reading the session rather than anything a client could write.
	await expect(page.getByText(email)).toBeVisible();

	// And the shared-budget fact, which is the thing a host with two rooms is
	// most likely to get wrong.
	await expect(page.getByText(/One budget covers every room you run/)).toBeVisible();
});

test('a stale week is rolled before it is shown (AR-COST-6)', async ({ page }) => {
	// The lazy roll, from the surface a person reads. `roll_account` is
	// service-role only, so a page that read `accounts` straight from the
	// browser would show last week's total here — which is exactly why this
	// load goes through the server.
	const userId = await signInAsAccount(page, testEmail('account'));
	const { error } = await adminClient()
		.from('accounts')
		.update({
			weekly_seconds_used: 10 * 3600,
			weekly_cap_seconds: 10 * 3600,
			week_resets_at: new Date(Date.now() - 8 * 86_400_000).toISOString()
		})
		.eq('id', userId);
	if (error !== null) throw new Error(`could not stale the account: ${error.message}`);

	await page.goto('/account');
	await expect(page.getByText('10h left this week')).toBeVisible();
});

test('a guest is told they have no address or budget, not shown a fake one', async ({ page }) => {
	// An anonymous identity has a real account row with a full budget it can
	// never spend, because rooms belong to accounts (AR-AUTH-7). Showing them
	// "10h left" would be true and meaningless.
	//
	// Entering a room is what mints the anonymous session — the same path a
	// person invited by a link walks, and the only way to reach this branch
	// without inventing a session the app would never create.
	await joinRoom(page, roomName('acct'));

	await page.goto('/account');
	await hydrated(page);

	await expect(page.getByText(/here as a guest/)).toBeVisible();
	// The two things that must NOT appear: a budget they cannot spend, and a
	// change-email form for an address they do not have.
	await expect(page.getByText(/left this week/)).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'New email' })).toHaveCount(0);
	// And a way forward, since this is the one page that explains the boundary.
	await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
});

test('changing the address notifies both inboxes and lands on one confirmation', async ({
	page
}) => {
	const original = testEmail('account-old');
	const wanted = testEmail('account-new');
	const userId = await signInAsAccount(page, original);

	await page.goto('/account');
	await hydrated(page);
	await page.getByRole('textbox', { name: 'New email' }).fill(wanted);
	await page.getByRole('button', { name: /Send confirmation links/ }).click();

	// The message must promise a link, not a change.
	const status = page.getByRole('status');
	await expect(status).toContainText(wanted);
	await expect(status).toContainText(/opening the link in either one/i);

	// And the account genuinely has NOT moved yet. This is the assertion that
	// would catch the page being rewritten to claim success optimistically.
	const before = await adminClient().auth.admin.getUserById(userId);
	expect(before.data.user?.email).toBe(original);

	// Follow the link sent to the NEW address, which is half the confirmation.
	// Reading the real mail rather than minting a token: an email_change link is
	// shaped by the `emailRedirectTo` this app passes, and nothing else proves
	// that shape is right (AR-TEST-8's argument, applied to a second flow).
	let messageId = '';
	await expect
		.poll(
			async () => {
				const found = await page.request.get(
					`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${wanted}`)}`
				);
				const body = searchResult.safeParse(await found.json());
				messageId = body.success ? (body.data.messages[0]?.ID ?? '') : '';
				return messageId;
			},
			{ timeout: 15_000 }
		)
		.not.toBe('');

	const full = await page.request.get(`${MAILPIT}/api/v1/message/${messageId}`);
	const parsed = mailBody.safeParse(await full.json());
	expect(parsed.success).toBe(true);
	const link = /https?:\/\/[^\s"'<>]+/.exec(parsed.success ? parsed.data.Text : '')?.[0] ?? '';
	expect(link).not.toBe('');

	// The CURRENT address is told too, and that notification is the whole of the
	// protection here — so it is asserted, not assumed. If a future config
	// change stopped mailing the old address, an account could be moved away
	// from someone with no signal at all, and nothing else would notice.
	const toldOwner = await page.request.get(
		`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${original}`)}`
	);
	const ownerMail = searchResult.safeParse(await toldOwner.json());
	expect(ownerMail.success && ownerMail.data.messages.length).toBeGreaterThan(0);

	await page.goto(link);

	/*
	 * ONE confirmation completes it.
	 *
	 * This asserted the opposite first — that the address stays put until both
	 * inboxes answer — because `double_confirm_changes = true` says exactly
	 * that. It is not what happens while `enable_confirmations` is false: the
	 * second side auto-confirms, and following EITHER link is enough (probed in
	 * both directions). The copy was corrected to match, and this pins the real
	 * behaviour so the next person to read that flag is not misled by a green
	 * suite. See supabase/config.toml.
	 */
	const after = await adminClient().auth.admin.getUserById(userId);
	expect(after.data.user?.email).toBe(wanted);
});
