import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import type { RoomState } from '$lib/model/types';
import { roomStateSchema } from '$lib/model/schemas';

/**
 * Postgres renders `timestamptz` as `2026-07-19 05:00:00+00` — a space, and a
 * `+00` offset. The schema demands strict ISO 8601 (`T`, `Z`), which is what
 * the browser produces and what every stored room already contains. The
 * database's representation and the wire format genuinely differ, so the
 * loader is where they are reconciled; without this every object round-trips
 * as "Invalid ISO datetime" the moment it is read back.
 */
function isoTime(value: string): string {
	return new Date(value).toISOString();
}

/**
 * Assemble a RoomState from Postgres, and write one back.
 *
 * The shape is `roomStateSchema` — the SAME schema the canvas renders and the
 * rule engine mutates — so the database is a projection of one model rather
 * than a second definition of it. Everything read here is parsed by that schema
 * before it is trusted, exactly as the stub parses localStorage.
 */
export async function loadRoomState(
	db: SupabaseClient<Database>,
	roomId: string
): Promise<RoomState | null> {
	const [state, objects, participants, configurations, locations] = await Promise.all([
		db.from('room_state').select('*').eq('room_id', roomId).maybeSingle(),
		db.from('room_objects').select('*').eq('room_id', roomId),
		db.from('room_participants').select('*').eq('room_id', roomId),
		db.from('room_configurations').select('*').eq('room_id', roomId),
		db.from('participant_locations').select('*').eq('room_id', roomId)
	]);
	if (state.data === null) return null;

	const row = state.data;
	const parsed = roomStateSchema.safeParse({
		objects: Object.fromEntries(
			(objects.data ?? []).map((o) => [
				o.id,
				{
					id: o.id,
					type: o.type,
					creator_id: o.creator_id,
					permission: o.permission,
					hidden: o.hidden,
					transform: o.transform,
					clip: o.clip,
					border: o.border,
					payload: o.payload,
					created_at: isoTime(o.created_at),
					updated_at: isoTime(o.updated_at)
				}
			])
		),
		participants: Object.fromEntries(
			(participants.data ?? []).map((p) => [
				p.id,
				{
					id: p.id,
					name: p.name,
					emoji: p.emoji,
					location: p.location,
					size: p.size,
					rotation: p.rotation,
					clip: p.clip,
					fake: p.fake,
					away: p.away,
					muted: p.muted
				}
			])
		),
		background: row.background,
		title: row.title,
		description: row.description,
		create_permission: row.create_permission,
		border_default: row.border_default,
		capacity: {
			max_participants: row.max_participants,
			max_av: row.max_av,
			max_audio: row.max_audio
		},
		video_holders: row.video_holders,
		audio_holders: row.audio_holders,
		queue: row.queue,
		transport: row.transport,
		placers: row.placers,
		active_config: row.active_config,
		configurations: Object.fromEntries(
			(configurations.data ?? []).map((c) => [c.id, { id: c.id, name: c.name, snapshot: c.snapshot }])
		),
		participant_locations: Object.fromEntries(
			(locations.data ?? []).map((l) => [l.config_key, { x: l.x, y: l.y }])
		)
	});

	// A row that no longer satisfies the schema is a bug worth surfacing, not
	// one to paper over with defaults — the stub's equivalent path warns and
	// starts fresh, which a server may not do to someone's room.
	if (!parsed.success) throw new Error(`room ${roomId} failed validation: ${parsed.error.message}`);
	return parsed.data;
}

/**
 * Persist a mutated RoomState.
 *
 * Writes the whole projection rather than a computed diff. That is a
 * deliberate first cut: correctness before cleverness, and the shape that a
 * diff would optimise is the shape Realtime fan-out will dictate anyway
 * (AR-BACKEND-4). It is bounded by room size, not by history.
 *
 * Not yet transactional across tables — that arrives with the CAS function and
 * broadcast trigger, and is called out here rather than left to be discovered:
 * a failure midway currently leaves a room partially written.
 */
export async function saveRoomState(
	db: SupabaseClient<Database>,
	roomId: string,
	state: RoomState
): Promise<void> {
	await db
		.from('room_state')
		.update({
			background: state.background,
			title: state.title,
			description: state.description,
			create_permission: state.create_permission,
			border_default: state.border_default,
			max_participants: state.capacity.max_participants,
			max_av: state.capacity.max_av,
			max_audio: state.capacity.max_audio,
			video_holders: state.video_holders,
			audio_holders: state.audio_holders,
			queue: state.queue,
			transport: state.transport,
			placers: state.placers,
			active_config: state.active_config,
			updated_at: new Date().toISOString()
		})
		.eq('room_id', roomId);

	const objects = Object.values(state.objects);
	if (objects.length > 0) {
		await db.from('room_objects').upsert(
			objects.map((o) => ({
				id: o.id,
				room_id: roomId,
				type: o.type,
				creator_id: o.creator_id,
				permission: o.permission,
				hidden: o.hidden,
				transform: o.transform,
				clip: o.clip,
				border: o.border,
				payload: o.payload,
				created_at: o.created_at,
				updated_at: o.updated_at
			}))
		);
	}
	// Deletions are absences, so they need their own pass.
	const keep = objects.map((o) => o.id);
	const stale = db.from('room_objects').delete().eq('room_id', roomId);
	await (keep.length > 0 ? stale.not('id', 'in', `(${keep.join(',')})`) : stale);

	const participants = Object.values(state.participants);
	if (participants.length > 0) {
		await db.from('room_participants').upsert(
			participants.map((p) => ({ room_id: roomId, ...p }))
		);
	}
}
