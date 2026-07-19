import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { SUPABASE_SECRET_KEY } from '$env/static/private';
import type { Database, Json } from '$lib/database.types';

/**
 * How concurrent writers interact (AR-BACKEND-4, AR-CANVAS-5).
 *
 * These call `save_room_state` and `get_room_state` DIRECTLY, below the HTTP
 * route, because the question is whether the concurrency mechanism is correct
 * and a browser adds only noise.
 *
 * They exist because the compare-and-swap had NO coverage anywhere — not
 * pgTAP, not integration, not e2e. Nothing fired two overlapping requests, so
 * three attempts at the store switchover diagnosed its behaviour by inference
 * instead of measurement, and all three were wrong about something.
 */

const db: SupabaseClient<Database> = createClient<Database>(
	PUBLIC_SUPABASE_URL,
	SUPABASE_SECRET_KEY,
	{ auth: { autoRefreshToken: false, persistSession: false } }
);

/** An empty diff touches nothing but still bumps the version. */
function emptyDiff() {
	return {
		room: null,
		objects: { upsert: [], remove: [] },
		participants: { upsert: [], remove: [] },
		configurations: { upsert: [], remove: [] },
		locations: { upsert: [], remove: [] },
		empty: false
	};
}

/**
 * A fresh id every time. Fixed ids were a real defect in this file: object ids
 * are GLOBAL primary keys, so reusing them across the per-test rooms meant each
 * test upserted the PREVIOUS test's row and then found its own room empty. That
 * failure is what surfaced the cross-room write fixed in
 * 20260719000012_scope_upserts_to_room.sql.
 */
function anObject(id: string, x: number) {
	return {
		id,
		type: 'note',
		creator_id: '00000000-0000-4000-8000-000000000000',
		permission: 'all',
		hidden: false,
		transform: { x, y: 0, width: 200, height: 160, rotation: 0, z: 1 },
		clip: { shape: 'rect' },
		border: { width: 10 },
		payload: { text: '', doc: '' },
		created_at: '2026-07-19T00:00:00.000Z',
		updated_at: '2026-07-19T00:00:00.000Z'
	};
}

let roomId = '';
let version = 0;

beforeEach(async () => {
	const email = `conc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
	const { data: user } = await db.auth.admin.createUser({ email, email_confirm: true });
	const { data, error } = await db
		.from('rooms')
		.insert({ name: `conc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, owner_id: user.user?.id ?? '' })
		.select('id, version')
		.single();
	if (error !== null) throw new Error(`could not create room: ${error.message}`);
	roomId = data.id;
	version = data.version;
});

/** Returns the error code, or null when the write succeeded. */
async function save(
	expected: number | null,
	diff: Json,
	objectVersions: Record<string, number> = {}
): Promise<string | null> {
	const { error } = await db.rpc('save_room_state', {
		p_room_id: roomId,
		p_diff: diff,
		p_object_versions: objectVersions,
		...(expected === null ? {} : { p_expected_version: expected })
	});
	return error?.code ?? null;
}

/** The versions the server currently holds, as `get_room_state` reports them. */
async function objectVersions(): Promise<Record<string, number>> {
	const { data } = await db.rpc('get_room_state', { p_room_id: roomId });
	const parsed = z
		.object({ object_versions: z.record(z.string(), z.number()) })
		.safeParse(data);
	return parsed.success ? parsed.data.object_versions : {};
}

/**
 * What the ROUTE does: re-read the version and retry, bounded at three.
 *
 * Measuring bare `save` calls would answer a question nobody has — of course N
 * writers sharing one expected version produce N-1 conflicts. The system only
 * loses a write when the retry budget is exhausted, so that is what these
 * measure.
 */
async function saveWithRetry(diff: Json): Promise<string | null> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const { data } = await db.from('rooms').select('version').eq('id', roomId).single();
		const code = await save(data?.version ?? 0, diff);
		if (code === null) return null;
		if (code !== 'PT409') return code;
	}
	return 'exhausted';
}

describe('the compare-and-swap', () => {
	it('rejects a stale writer', async () => {
		// The assertion that did not exist.
		const results = await Promise.all([
			save(version, emptyDiff()),
			save(version, emptyDiff())
		]);
		const failures = results.filter((code) => code !== null);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toBe('PT409');
	});

	it('reports the conflict promptly instead of stalling', async () => {
		// The switchover blocker, pinned as a test so it cannot come back.
		//
		// Raised as 40001 this same call took 60,007ms and returned "upstream
		// server is timing out", because PostgREST retries serialization_failure
		// internally and a CAS mismatch can never succeed on retry. It held a
		// pool connection for the whole minute; ten of those exhausted the pool
		// and every unrelated request then failed with a message about the pool,
		// which is what sent three investigations after the wrong cause.
		//
		// Deliberately generous: this asserts "does not stall", not a latency
		// budget that would flake on a loaded machine. The real measurement is
		// four orders of magnitude away from the bound.
		const started = Date.now();
		const code = await save(version + 999, emptyDiff());
		expect(code).toBe('PT409');
		expect(Date.now() - started).toBeLessThan(5000);
	});

	/** The state a writer starts from, read before anyone has written. */
	async function readSlots(): Promise<{ version: number; holders: string[] }> {
		const room = await db.from('rooms').select('version').eq('id', roomId).single();
		const state = await db.from('room_state').select('video_holders').eq('room_id', roomId).single();
		return { version: room.data?.version ?? 0, holders: state.data?.video_holders ?? [] };
	}

	/**
	 * A slot grab as the ROUTE performs it: read the holders, append, write.
	 * Modelling it as a fixed diff would test nothing — a fixed diff cannot lose
	 * an update, because it never read what it overwrites.
	 *
	 * `guarded: false` is the mutation: the same scenario, guard removed.
	 */
	async function takeSlot(
		holder: string,
		guarded: boolean,
		/**
		 * The snapshot this writer started from. Passed IN rather than read here,
		 * so the race is deterministic: reading inside would merely TEND to
		 * happen before the other writer's write, and one slow scheduler tick
		 * would let the second writer see the first's result and quietly turn the
		 * mutation test green.
		 */
		seen: { version: number; holders: string[] }
	): Promise<void> {
		let from = seen;
		for (let attempt = 0; attempt < 3; attempt++) {
			const holders = [...from.holders, holder];
			const code = await save(guarded ? from.version : null, {
				...emptyDiff(),
				room: {
					background: '', title: '', description: '', create_permission: 'all', admission: 'open',
					border_default: 10,
					capacity: { max_participants: 20, max_av: 4, max_audio: 8 },
					video_holders: holders, audio_holders: [], queue: [],
					transport: 'p2p', placers: [], active_config: null
				}
			});
			if (code === null) return;
			if (code !== 'PT409') throw new Error(`unexpected ${code}`);
			// Rejected, so re-read and re-apply — which is the whole point of
			// being guarded, and what lets the loser append to the winner's array.
			from = await readSlots();
		}
	}

	it('the guard is what stops a concurrent slot grab from being lost', async () => {
		// Both people take a slot from the SAME starting state. Guarded, the
		// loser is rejected, re-reads, and appends to the winner's array.
		const seen = await readSlots();
		await Promise.all([
			takeSlot('11111111-1111-4111-8111-111111111111', true, seen),
			takeSlot('22222222-2222-4222-8222-222222222222', true, seen)
		]);
		const { data } = await db.from('room_state').select('video_holders').eq('room_id', roomId).single();
		expect(data?.video_holders).toHaveLength(2);
	});

	it('MUTATION: without the guard, one of the two grabs is silently lost', async () => {
		// The same scenario with the guard removed. If this ever reports 2, the
		// guard above proves nothing and the test that depends on it is vacuous
		// — which is exactly how the earlier tooltip and placement tests passed
		// against broken builds.
		const seen = await readSlots();
		await Promise.all([
			takeSlot('11111111-1111-4111-8111-111111111111', false, seen),
			takeSlot('22222222-2222-4222-8222-222222222222', false, seen)
		]);
		const { data } = await db.from('room_state').select('video_holders').eq('room_id', roomId).single();
		expect(data?.video_holders).toHaveLength(1);
	});

	it('still serialises a contended slot, so a cap cannot be violated', async () => {
		// Two people grabbing the LAST free slot. stage.ts builds
		// order-significant whole-array replacements, so losing this would let
		// both hold one slot and silently break max_av (AR-MEDIA-1).
		const scalars = (holder: string) => ({
			background: '', title: '', description: '', create_permission: 'all', admission: 'open',
			border_default: 10,
			capacity: { max_participants: 20, max_av: 1, max_audio: 8 },
			video_holders: [holder], audio_holders: [], queue: [],
			transport: 'p2p', placers: [], active_config: null
		});
		const results = await Promise.all([
			save(version, { ...emptyDiff(), room: scalars('11111111-1111-4111-8111-111111111111') }),
			save(version, { ...emptyDiff(), room: scalars('22222222-2222-4222-8222-222222222222') })
		]);
		expect(results.filter((code) => code !== null)).toHaveLength(1);

		// Exactly one holder survived — not two.
		const { data } = await db.from('room_state').select('video_holders').eq('room_id', roomId).single();
		expect(data?.video_holders).toHaveLength(1);
	});
});

describe('a write cannot reach into another room', () => {
	it('refuses to overwrite an object belonging to a different room', async () => {
		// Object ids are GLOBAL primary keys, so `on conflict (id) do update`
		// used to match a row in another room and take the writer's content
		// without moving the row. Measured before the fix: room A's payload
		// became {"text":"PWNED"} and the row still belonged to room A.
		//
		// Reachable from the route by any authenticated member of any room: the
		// rule engine judges create_object against the room being written, where
		// the borrowed id is absent, so nothing rejects it. The collision only
		// happens afterwards, in SQL.
		const victimRoom = roomId;
		const victim = anObject(crypto.randomUUID(), 0);
		expect(await save(null, { ...emptyDiff(), objects: { upsert: [victim], remove: [] } })).toBeNull();

		// A second room, and a write from it borrowing the victim's id.
		const { data: user } = await db.auth.admin.createUser({
			email: `x-${crypto.randomUUID()}@example.test`,
			email_confirm: true
		});
		const { data: other } = await db
			.from('rooms')
			.insert({ name: `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, owner_id: user.user?.id ?? '' })
			.select('id')
			.single();

		const attack = { ...victim, payload: { text: 'PWNED', doc: '' } };
		await db.rpc('save_room_state', {
			p_room_id: other?.id ?? '',
			p_diff: { ...emptyDiff(), objects: { upsert: [attack], remove: [] } }
		});

		// The victim is untouched, and the attacker's room did not gain it.
		const { data: after } = await db
			.from('room_objects')
			.select('room_id, payload')
			.eq('id', victim.id)
			.single();
		expect(after?.room_id).toBe(victimRoom);
		expect(after?.payload).toEqual({ text: '', doc: '' });
	});
});

describe('per-object versions', () => {
	it('two writers editing the SAME object: one is refused', async () => {
		// Before object versions this was UNGUARDED — an object write that
		// changed no room scalar took no CAS at all, so both writers landed and
		// the loser's edit vanished with nothing to notice it.
		const note = anObject(crypto.randomUUID(), 0);
		expect(await save(null, { ...emptyDiff(), objects: { upsert: [note], remove: [] } })).toBeNull();
		const seen = await objectVersions();

		const edit = (text: string) => ({
			...emptyDiff(),
			objects: { upsert: [{ ...note, payload: { text, doc: '' } }], remove: [] }
		});
		const results = await Promise.all([
			save(null, edit('from A'), seen),
			save(null, edit('from B'), seen)
		]);

		const refused = results.filter((code) => code !== null);
		expect(refused).toEqual(['PT409']);
	});

	it('MEASURED: two writers editing DIFFERENT objects never conflict', async () => {
		// THE false conflict this change removes. `edit_note` used to take the
		// ROOM guard, so typing in one note conflicted with typing in another —
		// and each conflict costs a re-read and a re-apply, with the edit dropped
		// once the bounded retry is exhausted.
		const a = anObject(crypto.randomUUID(), 0);
		const b = anObject(crypto.randomUUID(), 400);
		await save(null, { ...emptyDiff(), objects: { upsert: [a, b], remove: [] } });
		const seen = await objectVersions();

		const results = await Promise.all([
			save(null, { ...emptyDiff(), objects: { upsert: [{ ...a, payload: { text: 'A types', doc: '' } }], remove: [] } }, seen),
			save(null, { ...emptyDiff(), objects: { upsert: [{ ...b, payload: { text: 'B types', doc: '' } }], remove: [] } }, seen)
		]);
		expect(results.filter((code) => code !== null)).toEqual([]);
	});

	it('a new object needs no expectation, so creating still works', async () => {
		// An object absent from the map is new to this writer; guarding it
		// against a version it never read would refuse every create.
		const fresh = anObject(crypto.randomUUID(), 0);
		expect(
			await save(null, { ...emptyDiff(), objects: { upsert: [fresh], remove: [] } }, {})
		).toBeNull();
	});

	it('the winner keeps its write, and the version advances', async () => {
		const note = anObject(crypto.randomUUID(), 0);
		await save(null, { ...emptyDiff(), objects: { upsert: [note], remove: [] } });
		const before = await objectVersions();

		expect(
			await save(
				null,
				{ ...emptyDiff(), objects: { upsert: [{ ...note, payload: { text: 'kept', doc: '' } }], remove: [] } },
				before
			)
		).toBeNull();

		const after = await objectVersions();
		expect(after[note.id]).toBeGreaterThan(before[note.id] ?? 0);
		const { data } = await db.from('room_objects').select('payload').eq('id', note.id).single();
		expect(data?.payload).toEqual({ text: 'kept', doc: '' });
	});
});

describe('concurrent writers, through the retry the route actually performs', () => {
	it('two writers touching different objects both land', async () => {
		const a = { ...emptyDiff(), objects: { upsert: [anObject(crypto.randomUUID(), 0)], remove: [] } };
		const b = { ...emptyDiff(), objects: { upsert: [anObject(crypto.randomUUID(), 400)], remove: [] } };

		// Unguarded, because `needsGuard` says so: both diffs leave `room` null
		// and neither kind merges. Two different rows, nothing to lose.
		const results = await Promise.all([save(null, a), save(null, b)]);
		expect(results.filter((code) => code !== null)).toEqual([]);

		const { data } = await db.from('room_objects').select('id').eq('room_id', roomId);
		expect(data).toHaveLength(2);
	});

	it('MEASURED: twenty concurrent writers all keep their write', async () => {
		// The step the failed attempts skipped, and the one that decides whether
		// the room-wide CAS needs narrowing at all.
		//
		// The plan proposed making the guard nullable so disjoint edits would
		// stop conflicting. That was reasoned from "conflicts saturate the
		// pool" — which turned out to be false: the pool died from 60s stalls,
		// not from conflict COUNT. Narrowing the guard costs real safety
		// (last-writer-wins per row), so it has to be justified by a measurement
		// rather than by the theory that has already been wrong three times.
		//
		// If every writer keeps its write here, the room-wide CAS is adequate
		// and the narrowing is unnecessary complexity.
		const writers = 20;
		const started = Date.now();
		const results = await Promise.all(
			Array.from({ length: writers }, (_, i) =>
				// Unguarded — what the route sends for a disjoint object write.
				// Guarded, this same measurement loses 15-17 of the 20.
				save(null, {
					...emptyDiff(),
					objects: {
						upsert: [anObject(crypto.randomUUID(), i * 400)],
						remove: []
					}
				})
			)
		);
		const elapsed = Date.now() - started;
		const lost = results.filter((code) => code !== null);
		console.log(
			`[measured] ${String(writers)} concurrent writers: ${String(lost.length)} lost, ${String(elapsed)}ms`
		);

		expect(lost).toEqual([]);
		// Every object survived — no write was silently overwritten.
		const { data } = await db.from('room_objects').select('id').eq('room_id', roomId);
		expect(data).toHaveLength(writers);
	});

	it('guarded writes serialise rather than lose, at the concurrency they see', async () => {
		// The other half of the trade. Guarded writes DO still conflict — that is
		// their job — but the bounded retry absorbs it, so a slot grab or a note
		// keystroke is delayed rather than dropped. This is why the guard being
		// narrow matters: it is affordable at two writers and lossy at twenty,
		// and `needsGuard` keeps the twenty-writer traffic out of it.
		const results = await Promise.all([
			saveWithRetry({ ...emptyDiff(), objects: { upsert: [anObject(crypto.randomUUID(), 0)], remove: [] } }),
			saveWithRetry({ ...emptyDiff(), objects: { upsert: [anObject(crypto.randomUUID(), 400)], remove: [] } })
		]);
		expect(results.filter((code) => code !== null)).toEqual([]);
	});

	it('the version advances on every write, because broadcasts depend on it', async () => {
		// The client drops any broadcast at or below its local version, so a
		// write that did not advance it would be invisible to every peer.
		expect(await save(version, emptyDiff())).toBeNull();
		const { data } = await db.from('rooms').select('version').eq('id', roomId).single();
		expect(data?.version).toBeGreaterThan(version);
	});
});
