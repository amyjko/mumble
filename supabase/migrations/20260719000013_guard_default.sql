-- Make "unguarded" expressible in TypeScript, not just in SQL.
--
-- `p_expected_version` became nullable in 20260719000011, but the generated
-- database types render a function argument as `number` no matter what: SQL
-- arguments are always nullable and the generator has nowhere to say so. So the
-- call that passes null did not typecheck, and the only ways through were a
-- type assertion (banned repo-wide) or a sentinel like -1 meaning "unguarded",
-- which trades a type error for a value nobody can read.
--
-- A DEFAULT is the honest fix: the generator marks defaulted arguments
-- OPTIONAL, so the unguarded call simply omits the key and reads as what it is.
-- The parameter has to move last because Postgres requires defaulted parameters
-- to be trailing; PostgREST calls by NAME, so no caller depends on the order.
--
-- Body otherwise unchanged from 20260719000012.

drop function if exists public.save_room_state(uuid, bigint, jsonb);
drop function if exists public.save_room_state(uuid, jsonb, bigint);

create or replace function public.save_room_state(
	p_room_id uuid,
	p_diff jsonb,
	p_expected_version bigint default null
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
			payload = excluded.payload, updated_at = excluded.updated_at
		-- Refuse to reach into another room. See the header.
		where room_objects.room_id = excluded.room_id;
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
		on conflict (id) do update set name = excluded.name, snapshot = excluded.snapshot
		where room_configurations.room_id = excluded.room_id;
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

revoke all on function public.save_room_state(uuid, jsonb, bigint) from public;
grant execute on function public.save_room_state(uuid, jsonb, bigint) to service_role;
