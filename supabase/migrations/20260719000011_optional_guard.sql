-- The version guard becomes conditional (AR-BACKEND-4).
--
-- MEASURED, once conflicts stopped costing 60s and could finally be counted:
-- twenty concurrent writers touching twenty DIFFERENT objects, each retrying
-- three times as the route does, lost SEVENTEEN of their twenty writes. A
-- single room-wide counter means every writer invalidates every other writer,
-- so under real drag traffic the retry budget is exhausted almost immediately
-- and edits vanish silently.
--
-- This was going to be done on the theory that conflicts saturated the pool.
-- That theory was wrong (see 20260719000010) and the change is kept anyway,
-- because the measurement that replaced it is worse than the theory: not slow,
-- but LOSSY.
--
-- So: guard only writes that read what they overwrite. The route sets
-- p_expected_version non-null when a room scalar changed (every stage,
-- capacity, placer and layout write) or when the mutation merges into existing
-- row content (edit_note, post_message). Everything else is disjoint per row,
-- where last-writer-wins is not just acceptable but correct.
--
-- The version advances either way — the client uses it only to drop stale
-- broadcasts, so an unguarded write must still wake the room.

drop function if exists public.save_room_state(uuid, bigint, jsonb);

create or replace function public.save_room_state(
	p_room_id uuid,
	p_expected_version bigint,
	p_diff jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
	next_version bigint;
	room_scalars jsonb := p_diff->'room';
	item jsonb;
begin
	-- The guard is OPTIONAL, and the caller decides (see the route).
	--
	-- Null means "this write cannot lose anything by landing second": two
	-- people dragging two different objects write two different rows, so
	-- serialising them buys nothing and costs a retry. Non-null means the write
	-- reads state it is about to replace — a stage array, a Yjs document — and
	-- must not clobber a committed one.
	if p_expected_version is null then
		update rooms set version = version + 1, updated_at = now()
		where id = p_room_id
		returning version into next_version;

		-- Unguarded, so the only way to match nothing is a room that is not
		-- there. Saying "conflict" for that would be a lie the caller retries.
		if next_version is null then
			raise exception 'no such room' using errcode = 'PT404';
		end if;
	else
		update rooms set version = version + 1, updated_at = now()
		where id = p_room_id and version = p_expected_version
		returning version into next_version;

		if next_version is null then
			raise exception 'version conflict' using errcode = 'PT409';
		end if;
	end if;

	-- Only when a scalar actually moved. A note keystroke does not touch this
	-- row at all, which is the point.
	if room_scalars is not null and jsonb_typeof(room_scalars) = 'object' then
		update room_state set
			background = room_scalars->>'background',
			title = room_scalars->>'title',
			description = room_scalars->>'description',
			create_permission = room_scalars->>'create_permission',
			border_default = (room_scalars->>'border_default')::numeric,
			max_participants = (room_scalars#>>'{capacity,max_participants}')::int,
			max_av = (room_scalars#>>'{capacity,max_av}')::int,
			max_audio = (room_scalars#>>'{capacity,max_audio}')::int,
			video_holders = coalesce((select array_agg(value::uuid) from jsonb_array_elements_text(room_scalars->'video_holders')), '{}'),
			audio_holders = coalesce((select array_agg(value::uuid) from jsonb_array_elements_text(room_scalars->'audio_holders')), '{}'),
			queue = coalesce((select array_agg(value::uuid) from jsonb_array_elements_text(room_scalars->'queue')), '{}'),
			transport = room_scalars->>'transport',
			placers = room_scalars->'placers',
			active_config = nullif(room_scalars->>'active_config', '')::uuid,
			updated_at = now()
		where room_id = p_room_id;
	end if;

	for item in select * from jsonb_array_elements(coalesce(p_diff#>'{objects,upsert}', '[]'::jsonb))
	loop
		insert into room_objects (id, room_id, type, creator_id, permission, hidden, transform, clip, border, payload, created_at, updated_at)
		values (
			(item->>'id')::uuid, p_room_id, item->>'type', (item->>'creator_id')::uuid,
			item->>'permission', (item->>'hidden')::boolean,
			item->'transform', item->'clip', item->'border', item->'payload',
			(item->>'created_at')::timestamptz, (item->>'updated_at')::timestamptz
		)
		on conflict (id) do update set
			type = excluded.type, permission = excluded.permission, hidden = excluded.hidden,
			transform = excluded.transform, clip = excluded.clip, border = excluded.border,
			payload = excluded.payload, updated_at = excluded.updated_at;
	end loop;

	delete from room_objects
	where room_id = p_room_id
	  and id in (select (value)::uuid from jsonb_array_elements_text(coalesce(p_diff#>'{objects,remove}', '[]'::jsonb)));

	for item in select * from jsonb_array_elements(coalesce(p_diff#>'{participants,upsert}', '[]'::jsonb))
	loop
		insert into room_participants (room_id, id, name, emoji, location, size, rotation, clip, fake, away, muted)
		values (
			p_room_id, (item->>'id')::uuid, item->>'name', item->>'emoji',
			item->'location', item->'size', (item->>'rotation')::numeric, item->'clip',
			(item->>'fake')::boolean, (item->>'away')::boolean, (item->>'muted')::boolean
		)
		on conflict (room_id, id) do update set
			name = excluded.name, emoji = excluded.emoji, location = excluded.location,
			size = excluded.size, rotation = excluded.rotation, clip = excluded.clip,
			away = excluded.away, muted = excluded.muted;
	end loop;

	delete from room_participants
	where room_id = p_room_id
	  and id in (select (value)::uuid from jsonb_array_elements_text(coalesce(p_diff#>'{participants,remove}', '[]'::jsonb)));

	for item in select * from jsonb_array_elements(coalesce(p_diff#>'{configurations,upsert}', '[]'::jsonb))
	loop
		insert into room_configurations (id, room_id, name, snapshot)
		values ((item->>'id')::uuid, p_room_id, item->>'name', item->'snapshot')
		on conflict (id) do update set name = excluded.name, snapshot = excluded.snapshot;
	end loop;

	delete from room_configurations
	where room_id = p_room_id
	  and id in (select (value)::uuid from jsonb_array_elements_text(coalesce(p_diff#>'{configurations,remove}', '[]'::jsonb)));

	-- Remembered placement is keyed by (participant, configuration) and its
	-- value carries no id, so the key travels alongside it (AR-CTRL-6).
	for item in select * from jsonb_array_elements(coalesce(p_diff#>'{locations,upsert}', '[]'::jsonb))
	loop
		insert into participant_locations (room_id, identity_id, config_key, x, y)
		values (
			p_room_id,
			nullif(split_part(item->>'key', ':', 1), '')::uuid,
			item->>'key',
			(item#>>'{point,x}')::numeric,
			(item#>>'{point,y}')::numeric
		)
		on conflict (room_id, identity_id, config_key) do update set
			x = excluded.x, y = excluded.y, updated_at = now();
	end loop;

	-- Fan-out in the SAME transaction, carrying a VERSION rather than the state:
	-- Realtime caps messages near 256 KB and a room with a couple of drawings
	-- exceeds that, failing silently. Clients re-read on a version change.
	-- Never Postgres Changes (AR-BACKEND-3).
	perform realtime.send(
		jsonb_build_object('version', next_version), 'state', 'room:' || p_room_id::text, false
	);

	return next_version;
end $$;

revoke all on function public.save_room_state(uuid, bigint, jsonb) from public;
grant execute on function public.save_room_state(uuid, bigint, jsonb) to service_role;
