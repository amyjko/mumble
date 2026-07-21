import { expect, test } from '@playwright/test';
import { joinRoom, roomName } from './support/join';
import { signInAsAccount, hostRoom } from './support/auth';

/**
 * Room names (UX-ROOM-9/10). The pattern used to exist in two places with each
 * caller separately remembering to lowercase; the reserved list required by
 * UX-ROOM-9 did not exist at all, and UX-ROOM-10's "hosts are warned before
 * renaming" was missing without even a comment admitting it.
 */

test('a reserved name is not a room', async ({ page }) => {
	// From outside, an unclaimable name and a nonexistent room are the same
	// thing, so this errors exactly as a malformed name does.
	//
	// Asserted on what the user SEES, not on the HTTP status, because a status
	// assertion would pass on a page that renders nothing.
	//
	// The reason used to be "ssr=false, so the shell always returns 200 and the
	// 404 comes from the client-side load". That stopped being true when
	// +page.server.ts started resolving the room against Postgres: `ssr = false`
	// disables server RENDERING, not server `load`, so the 404 is a real server
	// 404 now. The assertion is unchanged and still the right one.
	await page.goto('/admin');
	await expect(page.getByText('No such room')).toBeVisible();
});

test('a malformed name is refused the same way', async ({ page }) => {
	await page.goto('/a');
	await expect(page.getByText('No such room')).toBeVisible();
});

test('a reserved name that is a live route still resolves as that route', async ({ page }) => {
	// The collision the whole reservation scheme exists to prevent, and it only
	// became possible to have on 2026-07-21, when rooms moved from `/hey/<name>`
	// to the bare root. Nothing separates a room name from a route name now.
	//
	// SvelteKit sorts static segments ahead of dynamic ones, so `/login` should
	// beat `/[room]` — but "should" is doing real work in that sentence, and the
	// failure would be silent in the worst way: the sign-in page quietly
	// becoming a 404 for a room nobody made. So it is asserted, on the two
	// top-level routes an unauthenticated stranger can actually reach.
	//
	// `/new` is asserted on the SIGN-IN heading on purpose: its guard sends an
	// anonymous visitor to `/login?next=/new` (AR-AUTH-7). Landing there is
	// still proof the route ran — a room 404 has no redirect in it.
	for (const [route, heading] of [
		['/login', 'Sign in'],
		['/new', 'Sign in']
	] as const) {
		await page.goto(route);
		await expect(page.getByText('No such room')).toHaveCount(0);
		await expect(page.getByRole('heading', { name: heading })).toBeVisible();
	}
});

test('a well-formed name still resolves', async ({ page }) => {
	// Guards the negative cases above: if every route errored, they would pass
	// while proving nothing.
	await joinRoom(page, roomName('ok'));
	await expect(page.getByText('No such room')).toHaveCount(0);
});

test('the naming form explains WHY a name is rejected', async ({ page }) => {
	// /new is behind the account gate now (AR-AUTH-7), so reaching the form at
	// all requires a session — which is the point of the guard.
	await signInAsAccount(page);
	await page.goto('/new');
	const field = page.getByRole('textbox', { name: 'Room name' });
	const go = page.getByRole('button', { name: 'go' });

	await field.fill('admin');
	await expect(page.getByRole('alert')).toContainText(/reserved/i);
	await expect(go).toBeDisabled();

	await field.fill('a');
	await expect(page.getByRole('alert')).toContainText(/2–32/);
	await expect(go).toBeDisabled();

	await field.fill('stand-up');
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(go).toBeEnabled();
});

test('case-insensitive: an upper-case name reaches the lower-case room', async ({ page }) => {
	// A UNIQUE name, because rooms now live in Postgres and outlive the test
	// run — a fixed 'LCI' collided with its own previous execution, which is a
	// new failure mode that did not exist when rooms were localStorage.
	const room = roomName('case');
	await signInAsAccount(page);
	await page.goto('/new');
	await page.getByRole('textbox', { name: 'Room name' }).fill(room.toUpperCase());
	await page.getByRole('button', { name: 'go' }).click();
	await expect(page).toHaveURL(new RegExp(`/${room}$`));
});

test('rename warns that existing links will break (UX-ROOM-10)', async ({ page }) => {
	const room = roomName('rn');
	// Hosts, because the rename control is host-only now: the server refuses a
	// guest's rename, so offering them the field would be a control that can
	// only fail.
	await hostRoom(page, room);

	await page.getByRole('button', { name: room }).click();
	const field = page.getByRole('textbox', { name: 'New room name' });
	const rename = page.getByRole('button', { name: 'rename' });

	// A reserved target is refused with a reason, not silently ignored.
	await field.fill('admin');
	await expect(page.getByRole('alert')).toContainText(/reserved/i);
	await expect(rename).toBeDisabled();

	// A valid target warns before acting, and declining leaves the room alone.
	const target = `${room}-2`;
	await field.fill(target);
	await expect(rename).toBeEnabled();

	let warned = '';
	page.once('dialog', (dialog) => {
		warned = dialog.message();
		void dialog.dismiss();
	});
	await rename.click();
	expect(warned).toContain('lose access');
	await expect(page).toHaveURL(new RegExp(`/${room}$`));

	// Accepting it goes through.
	page.once('dialog', (dialog) => void dialog.accept());
	await rename.click();
	await expect(page).toHaveURL(new RegExp(`/${target}$`));

	// UX-ROOM-10's two remaining halves, and the reason the warning above is
	// not scaremongering: the old URL genuinely stops resolving...
	await page.goto(`/${room}`);
	await expect(page.getByText('No such room')).toBeVisible();

	// ...and the freed name is immediately claimable by anyone, which is the
	// clause that makes renaming a real cost rather than a soft alias. One
	// UPDATE frees it: there is no grace period and no redirect (both are open
	// items), so "immediately" is meant literally.
	await page.goto('/new');
	await page.getByRole('textbox', { name: 'Room name' }).fill(room);
	await page.getByRole('button', { name: 'go' }).click();
	await expect(page).toHaveURL(new RegExp(`/${room}$`));
});
