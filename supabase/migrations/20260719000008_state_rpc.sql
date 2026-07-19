-- Reading and writing room state in one round trip each (AR-BACKEND-4, AR-SYNC-3).

-- ---------------------------------------------------------------------------
-- Read
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER (the default) on purpose: the queries inside run as the
-- CALLER, so RLS still applies and a hidden object is filtered out by the
-- database rather than by the client being trusted to ignore it (UX-ROOM-3).
--
-- One call rather than five PostgREST queries: one round trip, one consistent
-- snapshot, and no chance of a torn read where objects arrive from before a
-- write and participants from after.
create or replace function public.get_room_state(p_room_id uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
	select jsonb_build_object(
		'version', r.version,
		'state', jsonb_build_object(
			'background', s.background,
			'title', s.title,
			'description', s.description,
			'create_permission', s.create_permission,
			'border_default', s.border_default,
			'capacity', jsonb_build_object(
				'max_participants', s.max_participants,
				'max_av', s.max_av,
				'max_audio', s.max_audio
			),
			'video_holders', to_jsonb(s.video_holders),
			'audio_holders', to_jsonb(s.audio_holders),
			'queue', to_jsonb(s.queue),
			'transport', s.transport,
			'placers', s.placers,
			'active_config', s.active_config,
			'objects', coalesce((
				select jsonb_object_agg(o.id, jsonb_build_object(
					'id', o.id, 'type', o.type, 'creator_id', o.creator_id,
					'permission', o.permission, 'hidden', o.hidden,
					'transform', o.transform, 'clip', o.clip, 'border', o.border,
					'payload', o.payload,
					-- Postgres renders timestamptz with a space and a +00 offset;
					-- the schema demands strict ISO. Formatted here so every
					-- reader gets the same shape.
					'created_at', to_char(o.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
					'updated_at', to_char(o.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
				))
				from room_objects o where o.room_id = p_room_id
			), '{}'::jsonb),
			'participants', coalesce((
				select jsonb_object_agg(p.id, jsonb_build_object(
					'id', p.id, 'name', p.name, 'emoji', p.emoji,
					'location', p.location, 'size', p.size, 'rotation', p.rotation,
					'clip', p.clip, 'fake', p.fake, 'away', p.away, 'muted', p.muted
				))
				from room_participants p where p.room_id = p_room_id
			), '{}'::jsonb),
			'configurations', coalesce((
				select jsonb_object_agg(c.id, jsonb_build_object('id', c.id, 'name', c.name, 'snapshot', c.snapshot))
				from room_configurations c where c.room_id = p_room_id
			), '{}'::jsonb),
			'participant_locations', coalesce((
				select jsonb_object_agg(l.config_key, jsonb_build_object('x', l.x, 'y', l.y))
				from participant_locations l where l.room_id = p_room_id
			), '{}'::jsonb)
		)
	)
	from room_state s join rooms r on r.id = s.room_id
	where s.room_id = p_room_id;
$$;

grant execute on function public.get_room_state(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Write
-- ---------------------------------------------------------------------------
-- ONE transaction: every table, the version bump, and the broadcast. That is
-- the property the previous per-table writes lacked — a failure midway left a
-- room partially written, and a client could see a broadcast for a write that
-- rolled back.
--
-- Compare-and-swap on `version`. A stale writer is told to re-read rather than
-- clobbering someone else's committed drag, which is also how AR-CANVAS-5's
-- concurrent-drag race resolves: the loser re-runs the solver against the
-- winner's settled position.
create or replace function public.save_room_state(
	p_room_id uuid,
	p_expected_version bigint,
	p_state jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
	next_version bigint;
	obj jsonb;
	par jsonb;
	cfg jsonb;
begin
	update rooms set version = version + 1, updated_at = now()
	where id = p_room_id and version = p_expected_version
	returning version into next_version;

	if next_version is null then
		-- Not an error the user should see as a failure: the caller re-reads and
		-- re-applies. Signalled by a distinct code so the route can tell it apart
		-- from a genuine rejection.
		raise exception 'version conflict' using errcode = '40001';
	end if;

	update room_state set
		background = p_state->>'background',
		title = p_state->>'title',
		description = p_state->>'description',
		create_permission = p_state->>'create_permission',
		border_default = (p_state->>'border_default')::numeric,
		max_participants = (p_state#>>'{capacity,max_participants}')::int,
		max_av = (p_state#>>'{capacity,max_av}')::int,
		max_audio = (p_state#>>'{capacity,max_audio}')::int,
		video_holders = coalesce((select array_agg(value::text::uuid) from jsonb_array_elements_text(p_state->'video_holders') as t(value)), '{}'),
		audio_holders = coalesce((select array_agg(value::text::uuid) from jsonb_array_elements_text(p_state->'audio_holders') as t(value)), '{}'),
		queue = coalesce((select array_agg(value::text::uuid) from jsonb_array_elements_text(p_state->'queue') as t(value)), '{}'),
		transport = p_state->>'transport',
		placers = p_state->'placers',
		active_config = nullif(p_state->>'active_config', '')::uuid,
		updated_at = now()
	where room_id = p_room_id;

	-- Objects: upsert everything present, then remove what is absent. Deletion
	-- is an absence, so it needs its own pass.
	for obj in select * from jsonb_array_elements(coalesce(jsonb_path_query_array(p_state->'objects', '$.*'), '[]'::jsonb))
	loop
		insert into room_objects (id, room_id, type, creator_id, permission, hidden, transform, clip, border, payload, created_at, updated_at)
		values (
			(obj->>'id')::uuid, p_room_id, obj->>'type', (obj->>'creator_id')::uuid,
			obj->>'permission', (obj->>'hidden')::boolean,
			obj->'transform', obj->'clip', obj->'border', obj->'payload',
			(obj->>'created_at')::timestamptz, (obj->>'updated_at')::timestamptz
		)
		on conflict (id) do update set
			type = excluded.type, permission = excluded.permission, hidden = excluded.hidden,
			transform = excluded.transform, clip = excluded.clip, border = excluded.border,
			payload = excluded.payload, updated_at = excluded.updated_at;
	end loop;

	delete from room_objects
	where room_id = p_room_id
	  and id not in (select (value->>'id')::uuid from jsonb_path_query(p_state->'objects', '$.*') as t(value));

	for par in select * from jsonb_array_elements(coalesce(jsonb_path_query_array(p_state->'participants', '$.*'), '[]'::jsonb))
	loop
		insert into room_participants (room_id, id, name, emoji, location, size, rotation, clip, fake, away, muted)
		values (
			p_room_id, (par->>'id')::uuid, par->>'name', par->>'emoji',
			par->'location', par->'size', (par->>'rotation')::numeric, par->'clip',
			(par->>'fake')::boolean, (par->>'away')::boolean, (par->>'muted')::boolean
		)
		on conflict (room_id, id) do update set
			name = excluded.name, emoji = excluded.emoji, location = excluded.location,
			size = excluded.size, rotation = excluded.rotation, clip = excluded.clip,
			away = excluded.away, muted = excluded.muted;
	end loop;

	delete from room_participants
	where room_id = p_room_id
	  and id not in (select (value->>'id')::uuid from jsonb_path_query(p_state->'participants', '$.*') as t(value));

	for cfg in select * from jsonb_array_elements(coalesce(jsonb_path_query_array(p_state->'configurations', '$.*'), '[]'::jsonb))
	loop
		insert into room_configurations (id, room_id, name, snapshot)
		values ((cfg->>'id')::uuid, p_room_id, cfg->>'name', cfg->'snapshot')
		on conflict (id) do update set name = excluded.name, snapshot = excluded.snapshot;
	end loop;

	delete from room_configurations
	where room_id = p_room_id
	  and id not in (select (value->>'id')::uuid from jsonb_path_query(p_state->'configurations', '$.*') as t(value));

	-- Fan-out, IN THE SAME TRANSACTION (AR-BACKEND-4). Deliberately a
	-- NOTIFICATION, not the state: Realtime caps messages around 256 KB and a
	-- room with a few drawings exceeds that, which would fail silently. Clients
	-- re-read on version change. Never Postgres Changes (AR-BACKEND-3).
	perform realtime.send(
		jsonb_build_object('version', next_version),
		'state',
		'room:' || p_room_id::text,
		false
	);

	return next_version;
end $$;

revoke all on function public.save_room_state(uuid, bigint, jsonb) from public;
grant execute on function public.save_room_state(uuid, bigint, jsonb) to service_role;

-- Channel-join authorization IS the room gate (AR-BACKEND-6). Checked once at
-- join, not per message, so the hot path stays untaxed. A pending member (when
-- admission lands) fails this and gets their own channel instead.
create policy room_channel_read on realtime.messages
	for select to authenticated
	using (
		public.is_admitted_member(
			nullif(split_part(realtime.topic(), ':', 2), '')::uuid
		)
	);
