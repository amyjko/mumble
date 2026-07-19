-- The version conflict must NOT use SQLSTATE 40001 (AR-BACKEND-4).
--
-- This is the defect that blocked the store switchover four times, and every
-- diagnosis before this one blamed volume. Measured, with NOTHING running
-- concurrently: a single stale write raising `40001` takes 60,007ms and comes
-- back as "The upstream server is timing out". The same raise as `PT409` takes
-- 7ms and returns cleanly.
--
-- 40001 is serialization_failure, which PostgREST treats as a TRANSIENT error
-- and retries internally rather than reporting. A CAS mismatch is deterministic
-- — the retry can never succeed — so the request stalls until the gateway kills
-- it, pinning a pool connection for a full minute. Ten conflicts exhausted the
-- 10-connection pool, and every unrelated request then failed with "Timed out
-- acquiring connection from connection pool". That symptom was read three times
-- as "we are writing too much", which is why the diff, the worker count and the
-- CAS granularity were each changed in turn without fixing anything.
--
-- PT409 is PostgREST's convention: SQLSTATE `PTxxx` sets HTTP status xxx, so a
-- version conflict surfaces as 409 Conflict, which is what the route already
-- returns. The body below is otherwise byte-identical to the previous version.

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
	-- Compare-and-swap. A stale writer re-reads rather than clobbering a
	-- committed drag; the route retries, bounded.
	update rooms set version = version + 1, updated_at = now()
	where id = p_room_id and version = p_expected_version
	returning version into next_version;

	if next_version is null then
		raise exception 'version conflict' using errcode = 'PT409';
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
