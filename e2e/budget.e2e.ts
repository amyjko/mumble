import { expect, test } from '@playwright/test';
import { joinRoom, roomName, settled, SYNC } from './support/join';
import { adminClient, createRoomDirectly, signInAsAccount } from './support/auth';

/**
 * The weekly time budget, as a person meets it (UX-ECON-2, AR-COST-4).
 *
 * The arithmetic is unit-tested, the privileges are pgTAP, and the wiring is an
 * integration spec. What only this layer can prove is that a refused join is
 * something a HUMAN can see and understand: the gate returns 402 from a route,
 * and a status code nobody renders is a locked door with no sign on it.
 *
 * Every test here sets the cap directly rather than burning ten hours of
 * metered time, which is the same reason the sweep tests write `last_seen`
 * rather than waiting 45 seconds. A cap of 0 is also a real operator action —
 * it is how a room gets suspended.
 */

/** The owner of a room, whose budget is the one that counts (UX-ID-4). */
async function ownerOf(room: string): Promise<string> {
	const { data } = await adminClient().from('rooms').select('owner_id').eq('name', room).single();
	return data?.owner_id ?? '';
}

async function setCap(owner: string, seconds: number): Promise<void> {
	const { error } = await adminClient()
		.from('accounts')
		.update({ weekly_cap_seconds: seconds })
		.eq('id', owner);
	if (error !== null) throw new Error(`could not set the cap: ${error.message}`);
}

test('a room out of time refuses a guest, and says when it opens again (UX-ECON-2)', async ({
	page
}) => {
	const room = roomName('budget');
	await createRoomDirectly(room);
	await setCap(await ownerOf(room), 0);

	await page.goto(`/${room}`);

	// The refusal comes BEFORE the join prompt: being asked to choose a name and
	// an avatar and only then turned away is the worse order, and the answer does
	// not depend on who they turn out to be.
	await expect(page.getByRole('heading', { name: 'This room is out of time' })).toBeVisible();
	await expect(page.getByRole('textbox', { name: 'Your name' })).toHaveCount(0);

	// The canvas is not merely hidden — it is never mounted.
	await expect(page.getByRole('application', { name: 'Room canvas' })).toHaveCount(0);

	// A refusal that cannot say when it lifts reads as a fault rather than a
	// limit, so the copy has to carry a real date from `week_resets_at`.
	await expect(page.getByText(/It opens again /)).toBeVisible();
});

test('the refusal is enforced at the write path, not only in the page (AR-COST-4)', async ({
	page
}) => {
	// The page load is the courtesy; this is the fact. A client that skipped the
	// screen entirely — a stale tab, a patched bundle — must still be refused,
	// because the gate that matters is the one on the mutation route.
	const room = roomName('budget');
	await createRoomDirectly(room);
	await setCap(await ownerOf(room), 0);

	// A real, signed-in, ADMITTED member — so the only thing left that can refuse
	// them is the budget. Without this the request would 401 or 403 and the test
	// would pass without the gate ever running, which is the failure mode that
	// makes a security test worthless.
	const userId = await signInAsAccount(page);
	const { error: joined } = await adminClient()
		.from('room_members')
		.insert({
			room_id: await createRoomDirectly(room),
			identity_id: userId,
			role: 'participant',
			status: 'admitted'
		});
	if (joined !== null) throw new Error(`could not add the member: ${joined.message}`);

	// An object rather than a tuple: tuples need a type assertion to survive the
	// trip through `evaluate`, and assertions are banned here.
	const refused = await page.evaluate(
		async ({ name, id }: { name: string; id: string }) => {
			const response = await fetch(`/api/rooms/${name}/mutate`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					kind: 'upsert_participant',
					participant: {
						id,
						name: 'Sneaky',
						emoji: '🦊',
						location: { x: 0, y: 0 },
						size: { width: 96, height: 96 },
						rotation: 0,
						clip: { shape: 'circle' },
						fake: false,
						away: false,
						muted: true
					}
				})
			});
			return response.status;
		},
		{ name: room, id: userId }
	);

	// Exactly 402, and the exactness is the assertion. Membership is settled, so
	// a 403 would mean the gate refused for the wrong reason and a 200 would mean
	// the page's refusal was theatre over a write path that still accepts anyone.
	expect(refused).toBe(402);
});

test('a room with budget left is untouched by the gate', async ({ page }) => {
	// The control, and not a formality: a gate that refuses everyone passes every
	// test above while breaking the product completely.
	const room = roomName('budget');
	await createRoomDirectly(room);
	await setCap(await ownerOf(room), 36000);

	await joinRoom(page, room);
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();
	await settled(page);
});

test('the heartbeat meters a guest’s time onto the room owner (AR-COST-3, UX-ID-4)', async ({
	page
}) => {
	// The route wiring, which nothing else covers: the unit test knows the
	// arithmetic and the integration test knows the SQL, but only this proves the
	// beat the app actually sends reaches the meter. The browser here is an
	// anonymous guest and the owner is an account they have never heard of, so it
	// re-proves attribution through the real path as well.
	const room = roomName('budget');
	await createRoomDirectly(room);
	const owner = await ownerOf(room);

	await joinRoom(page, room);
	await settled(page);

	// Wind this participant's last beat back rather than waiting 15 real seconds
	// for the next one — the same trick the sweep tests use on `last_seen`, and
	// for the same reason: the value is a server-written timestamp, so moving it
	// is exactly equivalent to time having passed.
	const { error: wound } = await adminClient()
		.from('room_participants')
		.update({ last_seen: new Date(Date.now() - 20_000).toISOString() })
		.eq('room_id', await createRoomDirectly(room));
	if (wound !== null) throw new Error(`could not wind the beat back: ${wound.message}`);

	const beat = await page.evaluate(async (name: string) => {
		const response = await fetch(`/api/rooms/${name}/heartbeat`, { method: 'POST' });
		return response.status;
	}, room);
	expect(beat).toBe(200);

	const { data } = await adminClient()
		.from('accounts')
		.select('weekly_seconds_used')
		.eq('id', owner)
		.single();
	// 20 seconds of presence, clamped by nothing and credited to the owner.
	expect(data?.weekly_seconds_used).toBe(20);
});

test('the toolbar shows how much time the room has left (UX-ECON-2)', async ({ page }) => {
	// The readout is fed by the heartbeat, which fires on mount — so this also
	// proves the beat's reply carries the budget and the page parses it.
	const room = roomName('budget');
	await createRoomDirectly(room);
	const owner = await ownerOf(room);
	// Six hours used of ten: comfortably above the warning threshold.
	const { error: spent } = await adminClient()
		.from('accounts')
		.update({ weekly_seconds_used: 6 * 3600, weekly_cap_seconds: 10 * 3600 })
		.eq('id', owner);
	if (spent !== null) throw new Error(`could not spend the budget: ${spent.message}`);

	await joinRoom(page, room);

	const readout = page.getByText(/left this week/);
	await expect(readout).toBeVisible({ timeout: SYNC });
	await expect(readout).toHaveText('4h left this week');

	// And it explains the consequence, which is the part a bare number cannot
	// carry: running out closes the room to NEW arrivals only.
	await expect(readout).toHaveAttribute('title', /nobody new can join/);
	await expect(readout).toHaveAttribute('title', /already here can stay/);
	// ...and that the budget is SHARED, not this room's own allowance. The copy
	// claimed "this room's weekly budget" first, which would have told a host
	// with two rooms they had twice the time they have.
	await expect(readout).toHaveAttribute('title', /every room the same host runs/);
	await expect(readout).not.toHaveAttribute('title', /this room's weekly budget/);
});

test('under an hour the readout changes colour, unit, and is announced (UX-ECON-2)', async ({
	page
}) => {
	const room = roomName('budget');
	await createRoomDirectly(room);
	const owner = await ownerOf(room);
	// 40 minutes left.
	const { error: spent } = await adminClient()
		.from('accounts')
		.update({ weekly_seconds_used: 10 * 3600 - 40 * 60, weekly_cap_seconds: 10 * 3600 })
		.eq('id', owner);
	if (spent !== null) throw new Error(`could not spend the budget: ${spent.message}`);

	await joinRoom(page, room);

	const readout = page.getByText(/left this week/);
	await expect(readout).toBeVisible({ timeout: SYNC });
	// Minutes, not hours — the unit change is the non-colour half of the signal.
	await expect(readout).toHaveText('40m left this week');

	// The colour actually resolves to the danger token rather than the muted one.
	// Asserting the COMPUTED value, not the class, because a class that no longer
	// maps to a colour would pass a class assertion and warn nobody.
	const [warned, muted] = await page.evaluate(() => {
		const el = document.querySelector('.budget');
		const root = document.documentElement;
		const read = (name: string) => getComputedStyle(root).getPropertyValue(name).trim();
		return [
			el === null ? '' : getComputedStyle(el).color,
			read('--text-muted')
		];
	});
	expect(warned).not.toBe('');
	expect(warned).not.toBe(muted);

	// WCAG 1.4.1: the warning must reach someone who cannot see the colour.
	await expect(readout).toHaveAttribute('aria-live', 'polite');
});

test('a budget that expired at the week boundary lets go by itself (AR-COST-6)', async ({
	page
}) => {
	// The lazy roll, end to end and from the outside. Nothing is scheduled, so
	// this room is only reopened by somebody trying the door — if the roll were
	// missing, or if it ran but did not persist, this room would stay shut
	// forever and no error anywhere would say why.
	const room = roomName('budget');
	await createRoomDirectly(room);
	const owner = await ownerOf(room);

	const lastWeek = new Date(Date.now() - 8 * 86_400_000).toISOString();
	const { error } = await adminClient()
		.from('accounts')
		.update({ weekly_seconds_used: 36000, weekly_cap_seconds: 36000, week_resets_at: lastWeek })
		.eq('id', owner);
	if (error !== null) throw new Error(`could not stale the account: ${error.message}`);

	await joinRoom(page, room);
	await expect(page.getByRole('application', { name: 'Room canvas' })).toBeVisible();

	// And the roll actually persisted, rather than being recomputed per read.
	const { data } = await adminClient()
		.from('accounts')
		.select('weekly_seconds_used, week_resets_at')
		.eq('id', owner)
		.single();
	expect(data?.weekly_seconds_used).toBe(0);
	expect(new Date(data?.week_resets_at ?? '').getTime()).toBeGreaterThan(Date.now());
});
