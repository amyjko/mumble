import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { SUPABASE_SECRET_KEY } from '$env/static/private';
import type { Database } from '$lib/database.types';
import { reapParticipants } from '$lib/model/rules';
import { freshRoomState } from '$lib/model/schemas';
import { newParticipant } from '$lib/model/avatar';
import { applyMutation } from '$lib/model/rules';

/**
 * The liveness sweep (AR-CTRL-3, UX-STAGE-4).
 *
 * Two halves, tested at the level each actually lives at: `reapParticipants` is
 * pure and gets the slot arithmetic; the `last_seen` column gets a real
 * database, because the sweep's whole premise is a timestamp the SERVER writes
 * and no client can forge.
 */

const db: SupabaseClient<Database> = createClient<Database>(
	PUBLIC_SUPABASE_URL,
	SUPABASE_SECRET_KEY,
	{ auth: { autoRefreshToken: false, persistSession: false } }
);

let roomId = '';

beforeEach(async () => {
	const email = `sweep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
	const { data: user } = await db.auth.admin.createUser({ email, email_confirm: true });
	const { data, error } = await db
		.from('rooms')
		.insert({
			name: `sweep${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
			owner_id: user.user?.id ?? ''
		})
		.select('id')
		.single();
	if (error !== null) throw new Error(`could not create room: ${error.message}`);
	roomId = data.id;
});

describe('reapParticipants', () => {
	const GONE = '11111111-1111-4111-8111-111111111111';
	const STAYS = '22222222-2222-4222-8222-222222222222';

	function roomWithBoth() {
		const state = freshRoomState();
		const ctx = { actorId: GONE, isHost: true };
		applyMutation(
			state,
			{ kind: 'upsert_participant', participant: newParticipant({ id: GONE, name: 'Gone', emoji: '🦊' }) },
			ctx
		);
		applyMutation(
			state,
			{ kind: 'upsert_participant', participant: newParticipant({ id: STAYS, name: 'Stays', emoji: '🐙' }) },
			{ actorId: STAYS, isHost: false }
		);
		return state;
	}

	it('releases the slot a vanished holder was keeping', () => {
		const state = roomWithBoth();
		applyMutation(state, { kind: 'take_slot', id: GONE, media: 'video' }, { actorId: GONE, isHost: false });
		expect(state.video_holders).toEqual([GONE]);

		reapParticipants(state, [GONE]);

		expect(state.participants[GONE]).toBeUndefined();
		// THE point: released, not merely vacated. A slot held by nobody is the
		// failure this exists to prevent.
		expect(state.video_holders).toEqual([]);
	});

	it('hands the slot to whoever was waiting', () => {
		// UX-STAGE-4: releasing passes to the head of the queue. A ghost holding
		// the conch while someone waits for it is the worst version of this bug.
		const state = roomWithBoth();
		state.capacity = { ...state.capacity, max_av: 1, max_audio: 0 };
		applyMutation(state, { kind: 'take_slot', id: GONE, media: 'video' }, { actorId: GONE, isHost: false });
		applyMutation(state, { kind: 'take_slot', id: STAYS, media: 'video' }, { actorId: STAYS, isHost: false });
		expect(state.video_holders).toEqual([GONE]);
		expect(state.queue).toEqual([STAYS]);

		reapParticipants(state, [GONE]);

		expect(state.video_holders).toEqual([STAYS]);
		expect(state.queue).toEqual([]);
	});

	it('leaves everyone else alone, and is idempotent', () => {
		const state = roomWithBoth();
		reapParticipants(state, [GONE]);
		reapParticipants(state, [GONE]);
		expect(state.participants[STAYS]).toBeDefined();
		expect(Object.keys(state.participants)).toEqual([STAYS]);
	});
});

describe('the last_seen column', () => {
	it('defaults to now, so a fresh participant is never swept', async () => {
		const id = crypto.randomUUID();
		await db.from('room_participants').insert({
			room_id: roomId,
			id,
			name: 'Fresh',
			emoji: '🦊',
			location: { x: 0, y: 0 },
			size: { width: 96, height: 96 },
			rotation: 0,
			clip: { shape: 'circle' },
			fake: false,
			away: false,
			muted: false
		});

		const cutoff = new Date(Date.now() - 45_000).toISOString();
		const stale = await db
			.from('room_participants')
			.select('id')
			.eq('room_id', roomId)
			.lt('last_seen', cutoff);
		expect(stale.data).toEqual([]);
	});

	it('finds a participant whose beat stopped', async () => {
		// The sweep's whole premise: staleness comes from a timestamp the SERVER
		// wrote, so a client cannot claim somebody else is gone.
		const id = crypto.randomUUID();
		await db.from('room_participants').insert({
			room_id: roomId,
			id,
			name: 'Stale',
			emoji: '🐙',
			location: { x: 0, y: 0 },
			size: { width: 96, height: 96 },
			rotation: 0,
			clip: { shape: 'circle' },
			fake: false,
			away: false,
			muted: false,
			last_seen: new Date(Date.now() - 120_000).toISOString()
		});

		const cutoff = new Date(Date.now() - 45_000).toISOString();
		const stale = await db
			.from('room_participants')
			.select('id')
			.eq('room_id', roomId)
			.lt('last_seen', cutoff);
		expect(stale.data?.map((row) => row.id)).toEqual([id]);
	});
});
