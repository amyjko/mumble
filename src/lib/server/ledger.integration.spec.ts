import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { SUPABASE_SECRET_KEY } from '$env/static/private';
import type { Database } from '$lib/database.types';
import { closeIntervals, meterBeat, roomBudget, roomBudgetResetsAt, roomHasTime } from './ledger';
import { STALE_AFTER_SECONDS } from '$lib/model/ledger';

/**
 * The meter and the gate against a real database (AR-COST-2..4, UX-ECON-2,
 * AR-TEST-7).
 *
 * The arithmetic is unit-tested in `model/ledger.spec.ts` and the privilege
 * matrix in pgTAP; what only a real round trip can prove is that the pieces are
 * wired to each other — that `meterBeat` reaches `meter_seconds`, that
 * `meter_seconds` finds the room's owner, and that `roomHasTime` reads the
 * counter the meter just moved. Each of those is a join between two layers, and
 * a join is exactly what a pure test cannot check.
 *
 * The load-bearing test here is the attribution one. If "who pays" ever quietly
 * reverts to "whoever was present", nothing breaks, no test that examines one
 * layer fails, and every guest-heavy room becomes free.
 */

const db: SupabaseClient<Database> = createClient<Database>(
	PUBLIC_SUPABASE_URL,
	SUPABASE_SECRET_KEY,
	{ auth: { autoRefreshToken: false, persistSession: false } }
);

let roomId = '';
let ownerId = '';

async function newUser(prefix: string): Promise<string> {
	const email = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
	const { data } = await db.auth.admin.createUser({ email, email_confirm: true });
	return data.user?.id ?? '';
}

async function account(id: string) {
	const { data } = await db.from('accounts').select('*').eq('id', id).single();
	return data;
}

beforeEach(async () => {
	ownerId = await newUser('ledger-owner');
	const { data, error } = await db
		.from('rooms')
		.insert({
			name: `ledger${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
			owner_id: ownerId
		})
		.select('id')
		.single();
	if (error !== null) throw new Error(`could not create room: ${error.message}`);
	roomId = data.id;
});

describe('the account behind a room', () => {
	it('exists the moment its owner does, without anyone creating it', async () => {
		// The trigger, seen from the application side. A metering path that had to
		// remember to create its own account row is one that would one day meter
		// nothing at all.
		expect(await account(ownerId)).not.toBeNull();
	});

	it('starts with a full week and is not exhausted', async () => {
		expect(await roomHasTime(db, roomId)).toBe(true);
	});
});

describe('meterBeat', () => {
	it('credits a guest’s seconds to the room OWNER, never to the guest', async () => {
		// UX-ID-4: hosts hold accounts, guests need not. This is the assertion
		// that catches attribution silently reverting to self — a change that
		// breaks nothing visible and makes every guest-heavy room free.
		const guestId = await newUser('ledger-guest');
		const now = new Date();
		const fifteenAgo = new Date(now.getTime() - 15_000);

		const credited = await meterBeat(db, roomId, guestId, fifteenAgo, now);
		expect(credited).toBe(15);

		expect((await account(ownerId))?.weekly_seconds_used).toBe(15);
		expect((await account(guestId))?.weekly_seconds_used).toBe(0);
	});

	it('accumulates across beats into ONE open interval', async () => {
		// Not a row per beat: at a 15s cadence that is 240 rows per person per
		// hour, for a trail nobody reads that finely.
		const guestId = await newUser('ledger-guest');
		const now = new Date();
		await meterBeat(db, roomId, guestId, new Date(now.getTime() - 15_000), now);
		await meterBeat(db, roomId, guestId, new Date(now.getTime() - 15_000), now);

		expect((await account(ownerId))?.weekly_seconds_used).toBe(30);

		const rows = await db
			.from('usage_ledger')
			.select('seconds, identity_id, left_at')
			.eq('room_id', roomId);
		expect(rows.data?.length).toBe(1);
		expect(rows.data?.[0]?.seconds).toBe(30);
		expect(rows.data?.[0]?.identity_id).toBe(guestId);
		expect(rows.data?.[0]?.left_at).toBeNull();
	});

	it('credits nothing on a first beat, so arriving is free', async () => {
		const guestId = await newUser('ledger-guest');
		expect(await meterBeat(db, roomId, guestId, null)).toBe(0);
		expect((await account(ownerId))?.weekly_seconds_used).toBe(0);
	});

	it('clamps a slept tab to the staleness threshold', async () => {
		// The crash-safety property, end to end: a tab that vanished for an hour
		// and came back must not bill for the hour nobody was present.
		const guestId = await newUser('ledger-guest');
		const now = new Date();
		await meterBeat(db, roomId, guestId, new Date(now.getTime() - 3_600_000), now);
		expect((await account(ownerId))?.weekly_seconds_used).toBe(STALE_AFTER_SECONDS);
	});
});

describe('closeIntervals', () => {
	it('stamps a departure without moving any seconds', async () => {
		const guestId = await newUser('ledger-guest');
		const now = new Date();
		await meterBeat(db, roomId, guestId, new Date(now.getTime() - 15_000), now);

		await closeIntervals(db, roomId, [guestId]);

		const rows = await db.from('usage_ledger').select('seconds, left_at').eq('room_id', roomId);
		expect(rows.data?.[0]?.left_at).not.toBeNull();
		// The seconds were credited beat by beat; closing is bookkeeping.
		expect(rows.data?.[0]?.seconds).toBe(15);
		expect((await account(ownerId))?.weekly_seconds_used).toBe(15);
	});

	it('opens a new interval when someone returns', async () => {
		const guestId = await newUser('ledger-guest');
		const now = new Date();
		await meterBeat(db, roomId, guestId, new Date(now.getTime() - 15_000), now);
		await closeIntervals(db, roomId, [guestId]);
		await meterBeat(db, roomId, guestId, new Date(now.getTime() - 7_000), now);

		const rows = await db.from('usage_ledger').select('seconds').eq('room_id', roomId);
		// Two visits, not one long one — which is what makes the trail worth
		// keeping at all.
		expect(rows.data?.length).toBe(2);
		expect((await account(ownerId))?.weekly_seconds_used).toBe(22);
	});
});

describe('one budget, many rooms', () => {
	it('spends the SAME budget in every room one person owns', async () => {
		// There is exactly one counter and one cap in the system, both on
		// `accounts`, so an owner's rooms do not get an allowance each — they
		// draw on one between them. Nothing pinned that until this test, and the
		// gap let a false claim ("the room total and the account total differ")
		// reach DESIGN.md and stand.
		//
		// It is also what makes the readout's wording load-bearing: a footnote
		// that calls this "this room's budget" is describing a per-room allowance
		// that does not exist.
		const second = await db
			.from('rooms')
			.insert({
				name: `ledger${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
				owner_id: ownerId
			})
			.select('id')
			.single();
		if (second.error !== null) throw new Error(`could not create room: ${second.error.message}`);

		const guestId = await newUser('ledger-guest');
		const now = new Date();
		// An hour spent in the FIRST room only. Nothing happens in the second.
		await meterBeat(db, roomId, guestId, new Date(now.getTime() - 3600_000), now);

		const first = await roomBudget(db, roomId);
		const untouched = await roomBudget(db, second.data.id);

		// The second room has had no presence at all and still reports the time
		// the first one spent.
		expect(untouched?.usedSeconds).toBe(first?.usedSeconds);
		expect(untouched?.usedSeconds).toBe(STALE_AFTER_SECONDS);

		// The ledger DOES know it per room — the trail can answer "where did the
		// week go" even though the cap cannot.
		const perRoom = await db
			.from('usage_ledger')
			.select('seconds')
			.eq('room_id', second.data.id);
		expect(perRoom.data).toEqual([]);
	});
});

describe('roomHasTime', () => {
	it('refuses once the owner’s week is spent', async () => {
		await db.from('accounts').update({ weekly_cap_seconds: 10 }).eq('id', ownerId);
		const guestId = await newUser('ledger-guest');
		const now = new Date();
		await meterBeat(db, roomId, guestId, new Date(now.getTime() - 15_000), now);

		expect(await roomHasTime(db, roomId)).toBe(false);
	});

	it('refuses a cap of zero outright', async () => {
		// The boundary AR-COST-4 specifies with `>=`. A cap of 0 is how a test —
		// and an operator suspending a room — says "nobody".
		await db.from('accounts').update({ weekly_cap_seconds: 0 }).eq('id', ownerId);
		expect(await roomHasTime(db, roomId)).toBe(false);
	});

	it('rolls a stale week before reading it, so a cap lets go on time', async () => {
		// AR-COST-6, and the reason the roll is lazy: nothing else runs. A budget
		// that expired at the week boundary is reset by somebody READING it, and
		// without that this room would stay shut forever.
		await db
			.from('accounts')
			.update({
				weekly_seconds_used: 36000,
				week_resets_at: new Date(Date.now() - 8 * 86_400_000).toISOString()
			})
			.eq('id', ownerId);

		expect(await roomHasTime(db, roomId)).toBe(true);
		expect((await account(ownerId))?.weekly_seconds_used).toBe(0);
	});

	it('reports when the budget next resets, for the copy that has to say so', async () => {
		const resets = await roomBudgetResetsAt(db, roomId);
		expect(resets).not.toBeNull();
		expect(new Date(resets ?? '').getTime()).toBeGreaterThan(Date.now());
	});

	it('fails OPEN for a room that does not exist', async () => {
		// Everybody locked out of every room at once is a far worse failure than
		// a free product being farmed for a while.
		expect(await roomHasTime(db, crypto.randomUUID())).toBe(true);
	});
});
