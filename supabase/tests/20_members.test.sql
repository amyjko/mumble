-- Membership, roles, and the host seed (AR-CTRL-7, UX-PERM-3).

begin;
select plan(8);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
	('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@example.test', '', now(), now(), now()),
	('bbbbbbbb-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'member@example.test', '', now(), now(), now()),
	('cccccccc-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stranger@example.test', '', now(), now(), now());

select tests.auth_as('aaaaaaaa-0000-4000-8000-000000000001'::uuid);
insert into rooms (name, owner_id) values ('retro', 'aaaaaaaa-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------------------
-- The creator is the first host, in the same transaction
-- ---------------------------------------------------------------------------
-- A room with no host is a room nobody can administer. Doing this in
-- application code means one failed round trip produces exactly that.
select is(
	(select role from room_members
	 where room_id = (select id from rooms where name = 'retro')
	   and identity_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
	'host',
	'creating a room makes the creator its host'
);

select is(
	(select status from room_members
	 where room_id = (select id from rooms where name = 'retro')
	   and identity_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
	'admitted',
	'and admitted — status is carried until AR-CTRL-5 gives it meaning'
);

select ok(
	public.is_host((select id from rooms where name = 'retro')),
	'is_host() agrees, which is what UX-PERM-3 will read'
);

-- ---------------------------------------------------------------------------
-- The self-referential policy does not recurse
-- ---------------------------------------------------------------------------
-- A policy ON room_members that queries room_members re-enters its own policy
-- forever. The SECURITY DEFINER helper breaks the cycle. Without it this
-- statement does not fail — it HANGS, which is why it is asserted rather than
-- assumed.
select lives_ok(
	$$select count(*) from room_members$$,
	'reading room_members terminates (no infinite policy recursion)'
);

-- ---------------------------------------------------------------------------
-- Visibility is scoped to rooms you are in
-- ---------------------------------------------------------------------------
select isnt_empty(
	$$select 1 from room_members where identity_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
	'a member sees their own membership'
);

select tests.auth_as('cccccccc-0000-4000-8000-000000000003'::uuid);
select is_empty(
	$$select 1 from room_members$$,
	'a stranger sees no membership rows at all'
);

-- The paired positive: the stranger can still SEE the room exists, so the
-- emptiness above is RLS scoping and not a missing grant.
select isnt_empty(
	$$select 1 from rooms where name = 'retro'$$,
	'...while still being able to see the room itself'
);

-- ---------------------------------------------------------------------------
-- Nobody can make themselves a member, let alone a host
-- ---------------------------------------------------------------------------
select throws_ok(
	$$insert into room_members (room_id, identity_id, role)
	  values ((select id from rooms where name = 'retro'), 'cccccccc-0000-4000-8000-000000000003', 'host')$$,
	'42501',
	null,
	'a client cannot grant itself membership or the host role'
);

select * from finish();
rollback;
