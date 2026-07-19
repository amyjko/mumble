-- Rooms and membership (AR-BACKEND-10, AR-CTRL-7, UX-ROOM-8..10, UX-PERM-3).
--
-- This is the first schema the project has ever had. Everything before it lived
-- in one browser's localStorage, which is why every permission gate has been
-- advisory: `actorId` was a string the client handed us.

create extension if not exists citext with schema extensions;

-- ---------------------------------------------------------------------------
-- Reserved names
-- ---------------------------------------------------------------------------
-- AR-BACKEND-10 asks for reserved names in "a table the same constraint path
-- consults". Taken literally that means a CHECK containing a subquery, which
-- Postgres accepts and should not: a CHECK is assumed immutable, so it is NOT
-- re-evaluated when the referenced table changes, and it reorders badly under
-- pg_dump/restore. Split instead: a pure CHECK for the charset/length rule, and
-- a trigger for the list. Both are still schema rather than application code,
-- which is what the requirement is actually protecting.
create table reserved_room_names (
	name citext primary key
);

-- Mirrors RESERVED_NAMES in src/lib/model/room-name.ts. Two copies of one list
-- is a real risk; a test asserts they agree, because the failure mode is a name
-- the UI rejects and the database accepts (or the reverse).
insert into reserved_room_names (name) values
	('new'), ('admin'), ('api'), ('about'), ('help'), ('support'),
	('settings'), ('login'), ('logout'), ('signup'), ('account'),
	('me'), ('you'), ('null'), ('undefined');

-- ---------------------------------------------------------------------------
-- Rooms
-- ---------------------------------------------------------------------------
create table rooms (
	id uuid primary key default gen_random_uuid(),
	-- citext + unique index gives UX-ROOM-9's case-insensitive uniqueness for
	-- free: `LCI` and `lci` cannot both exist.
	name citext not null unique,
	owner_id uuid not null references auth.users (id) on delete cascade,
	-- Optimistic concurrency for the mutation route (Phase 5). Every committed
	-- mutation bumps it; a stale writer is told to re-read rather than clobber.
	version bigint not null default 0,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	-- The pure half of AR-BACKEND-10: same rule as PATTERN in room-name.ts.
	constraint rooms_name_shape check (name ~ '^[a-z0-9_-]{2,32}$')
);

create or replace function reject_reserved_room_name()
returns trigger language plpgsql as $$
begin
	if exists (select 1 from reserved_room_names where name = new.name) then
		raise exception 'room name % is reserved', new.name
			using errcode = 'check_violation';
	end if;
	return new;
end $$;

create trigger rooms_reject_reserved
	before insert or update of name on rooms
	for each row execute function reject_reserved_room_name();

-- ---------------------------------------------------------------------------
-- Membership and roles (AR-CTRL-7)
-- ---------------------------------------------------------------------------
-- One table carries BOTH the authorization fact (role) and the admission fact
-- (status), so the two cannot disagree: UX-PERM-3's host gate and
-- AR-BACKEND-6's channel-join gate read the same row.
create table room_members (
	room_id uuid not null references rooms (id) on delete cascade,
	identity_id uuid not null references auth.users (id) on delete cascade,
	role text not null default 'participant' check (role in ('host', 'participant')),
	-- Carried at 'admitted' until AR-CTRL-5 lands, so admission is a behaviour
	-- change rather than a migration. Same trick as room_state.transport.
	status text not null default 'admitted' check (status in ('pending', 'admitted', 'declined')),
	-- UX-ID-2's join message. Unused until admission exists; here so the row
	-- that will carry it already has the column.
	hello text,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	primary key (room_id, identity_id)
);

create index room_members_identity_idx on room_members (identity_id);

-- The room's creator is its first host, in the same transaction that creates
-- the room. A room with no host is a room nobody can administer, and doing this
-- in application code means one failed round trip produces exactly that.
create or replace function seed_room_host()
returns trigger language plpgsql security definer set search_path = public as $$
begin
	insert into room_members (room_id, identity_id, role, status)
	values (new.id, new.owner_id, 'host', 'admitted');
	return new;
end $$;

create trigger rooms_seed_host
	after insert on rooms
	for each row execute function seed_room_host();
