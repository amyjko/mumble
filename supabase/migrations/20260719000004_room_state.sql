-- Canvas state (AR-CANVAS-3, AR-CTRL-2, AR-CTRL-6).
--
-- Rows, not one JSONB document per room, for two reasons that both bite:
--
--   1. UX-ROOM-3 requires a hidden object to be visible to its creator (and a
--      host) and invisible to everyone else. RLS cannot hide PART of a blob.
--   2. AR-BACKEND-4 fans out with realtime.broadcast_changes(), which carries
--      the changed ROW. One document per room would broadcast every drawing and
--      every chat log on each keystroke — the stub does exactly that today and
--      calls it "convergence over cleverness, at prototype scale". That scale
--      ends here.
--
-- A column for anything RLS, an index, or a trigger reads; JSONB for anything
-- only zod reads. Splitting `transform` into six columns would buy no query
-- capability and cost a second shape to keep in sync with schemas.ts.

create table room_state (
	room_id uuid primary key references rooms (id) on delete cascade,
	background text not null default '',
	title text not null default '',
	description text not null default '',
	create_permission text not null default 'all' check (create_permission in ('all', 'host')),
	border_default numeric not null default 10,
	-- AR-CTRL-2 verbatim. Holder lists are ORDERED arrays because acquisition
	-- order IS the FIFO rule (AR-MEDIA-1); a set would lose it.
	max_participants int not null default 20,
	max_av int not null default 4,
	max_audio int not null default 8,
	video_holders uuid[] not null default '{}',
	audio_holders uuid[] not null default '{}',
	queue uuid[] not null default '{}',
	transport text not null default 'p2p',
	active_config uuid,
	placers jsonb not null default '[]',
	updated_at timestamptz not null default now()
);

create table room_objects (
	id uuid primary key,
	room_id uuid not null references rooms (id) on delete cascade,
	-- Columns because RLS and indexes read them.
	type text not null,
	creator_id uuid not null,
	permission text not null default 'all' check (permission in ('all', 'host', 'none')),
	hidden boolean not null default false,
	-- JSONB because only zod reads them.
	transform jsonb not null,
	clip jsonb not null,
	border jsonb not null,
	payload jsonb not null default '{}',
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create index room_objects_room_idx on room_objects (room_id);

create table room_participants (
	room_id uuid not null references rooms (id) on delete cascade,
	id uuid not null,
	name text not null,
	emoji text not null,
	location jsonb not null,
	size jsonb not null,
	rotation numeric not null default 0,
	clip jsonb not null,
	fake boolean not null default false,
	away boolean not null default false,
	muted boolean not null default true,
	primary key (room_id, id)
);

create table room_configurations (
	id uuid primary key,
	room_id uuid not null references rooms (id) on delete cascade,
	name text not null,
	-- A snapshot IS a document: a pose per object, changed as a unit, read by
	-- nothing but zod. Normalising it would make switch_config write hundreds
	-- of rows and broadcast hundreds of messages for one user action.
	snapshot jsonb not null
);

create index room_configurations_room_idx on room_configurations (room_id);

-- AR-CTRL-6, verbatim: remembered placement per (identity, room, configuration).
create table participant_locations (
	room_id uuid not null references rooms (id) on delete cascade,
	identity_id uuid not null,
	config_key text not null,
	x numeric not null,
	y numeric not null,
	updated_at timestamptz not null default now(),
	primary key (room_id, identity_id, config_key)
);

-- Every room gets its state row when it is created, so no code path has to
-- cope with a room that exists and has no state.
create or replace function seed_room_state()
returns trigger language plpgsql security definer set search_path = public as $$
begin
	insert into room_state (room_id) values (new.id);
	return new;
end $$;

create trigger rooms_seed_state
	after insert on rooms
	for each row execute function seed_room_state();
