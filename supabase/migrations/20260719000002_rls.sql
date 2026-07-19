-- Row-level security for rooms and membership (AR-AUTH-2, AR-AUTH-7, AR-CTRL-7).
--
-- TWO LAYERS, and the outer one is the load-bearing half:
--
--   1. GRANTS. Clients get SELECT and nothing else. AR-SYNC-3's real claim is
--      "clients hold no write path that bypasses the control plane", and that is
--      delivered by privilege, not by which key the server holds. (The
--      requirement says "using the service-role client" — but service_role
--      BYPASSES RLS entirely, so if every write were service-role no write
--      policy would ever execute in production and the pgTAP matrix below would
--      be testing a fiction. Reworded in DESIGN.md.)
--
--   2. POLICIES. What a client may READ, and the one write it may perform.
--
-- Room creation is the deliberate exception: `authenticated` may INSERT a room,
-- precisely so AR-AUTH-7's restrictive anonymous check is a LIVE production gate
-- rather than dead code exercised only by tests.

alter table rooms enable row level security;
alter table room_members enable row level security;
alter table reserved_room_names enable row level security;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on rooms, room_members, reserved_room_names from anon, authenticated;
grant select on rooms, room_members, reserved_room_names to anon, authenticated;
grant insert on rooms to authenticated;

-- ---------------------------------------------------------------------------
-- Membership helpers
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER, and that is not incidental: a policy ON room_members that
-- queries room_members re-enters its own policy and recurses forever. The
-- definer function reads the table with RLS suspended, which breaks the cycle.
-- A pgTAP test below would hang without this.
create or replace function public.is_member(target_room uuid)
returns boolean language sql stable security definer set search_path = public as $$
	select exists (
		select 1 from room_members
		where room_id = target_room and identity_id = auth.uid()
	);
$$;

create or replace function public.is_admitted_member(target_room uuid)
returns boolean language sql stable security definer set search_path = public as $$
	select exists (
		select 1 from room_members
		where room_id = target_room
		  and identity_id = auth.uid()
		  and status = 'admitted'
	);
$$;

create or replace function public.is_host(target_room uuid)
returns boolean language sql stable security definer set search_path = public as $$
	select exists (
		select 1 from room_members
		where room_id = target_room
		  and identity_id = auth.uid()
		  and role = 'host'
		  and status = 'admitted'
	);
$$;

-- ---------------------------------------------------------------------------
-- rooms
-- ---------------------------------------------------------------------------
-- Rooms are addressable by anyone who has the link (UX-ROOM-1: "rooms are
-- always open"). Being able to SEE that a room exists is not being in it.
create policy rooms_select on rooms
	for select to anon, authenticated
	using (true);

create policy rooms_insert_own on rooms
	for insert to authenticated
	with check (owner_id = auth.uid());

-- AR-AUTH-7: creating a room requires a permanent account; joining does not
-- (UX-ID-4, "hosts hold accounts; guests need not").
--
-- RESTRICTIVE is mandatory here and the difference is invisible on inspection.
-- Permissive policies OR together, so a permissive version of this policy would
-- be ORed away by rooms_insert_own and allow anonymous creation while looking
-- completely correct — it would exist, read right, and do nothing. TESTING.md §7
-- reproduces exactly that, measured. Restrictive policies AND.
--
-- `is false`, not `= false`: a missing claim is NULL, and NULL = false is NULL.
create policy rooms_insert_permanent_only on rooms
	as restrictive for insert to authenticated
	with check ((auth.jwt() ->> 'is_anonymous')::boolean is false);

-- No UPDATE or DELETE policy: renames and deletions go through the control
-- plane, which holds the only write privilege for them.

-- ---------------------------------------------------------------------------
-- room_members
-- ---------------------------------------------------------------------------
-- You can see the membership of a room you are in, and no other.
create policy room_members_select on room_members
	for select to authenticated
	using (public.is_member(room_id));

-- No client write path at all: joining a room is a control-plane action, so a
-- client cannot make itself a member — much less a host.

-- ---------------------------------------------------------------------------
-- reserved_room_names
-- ---------------------------------------------------------------------------
-- Readable so a client can explain WHY a name was refused without a round trip
-- that leaks nothing anyway; the list is already in the shipped bundle.
create policy reserved_names_select on reserved_room_names
	for select to anon, authenticated
	using (true);
