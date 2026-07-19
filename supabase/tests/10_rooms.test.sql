-- Room names and the account gate (AR-BACKEND-10, AR-AUTH-7, UX-ROOM-9).

begin;
select plan(11);

-- Two real auth users: one permanent, one anonymous. The distinction is a JWT
-- claim, not a role — both are `authenticated`.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
	('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'host@example.test', '', now(), now(), now()),
	('bbbbbbbb-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'guest@example.test', '', now(), now(), now());

-- ---------------------------------------------------------------------------
-- The name rule lives in the schema, not just in application code
-- ---------------------------------------------------------------------------
select tests.auth_as('aaaaaaaa-0000-4000-8000-000000000001'::uuid);

select lives_ok(
	$$insert into rooms (name, owner_id) values ('standup', 'aaaaaaaa-0000-4000-8000-000000000001')$$,
	'a well-formed name is accepted'
);

-- UX-ROOM-9: LCI and lci are the same room. citext + unique index, not
-- application lowercasing that a caller can forget.
select throws_ok(
	$$insert into rooms (name, owner_id) values ('STANDUP', 'aaaaaaaa-0000-4000-8000-000000000001')$$,
	'23505',
	null,
	'case-insensitive uniqueness: STANDUP collides with standup'
);

select throws_ok(
	$$insert into rooms (name, owner_id) values ('a', 'aaaaaaaa-0000-4000-8000-000000000001')$$,
	'23514',
	null,
	'too short is refused by the CHECK'
);

select throws_ok(
	$$insert into rooms (name, owner_id) values ('Has Spaces', 'aaaaaaaa-0000-4000-8000-000000000001')$$,
	'23514',
	null,
	'charset is refused by the CHECK'
);

-- The reserved list is a trigger, not a subquery in a CHECK: a CHECK is assumed
-- immutable, so it would not re-evaluate when the list changes.
select throws_ok(
	$$insert into rooms (name, owner_id) values ('admin', 'aaaaaaaa-0000-4000-8000-000000000001')$$,
	'23514',
	null,
	'a reserved name is refused'
);

-- ---------------------------------------------------------------------------
-- AR-AUTH-7: creating a room requires an account
-- ---------------------------------------------------------------------------
-- Asserted as a PAIR. "Anonymous is blocked" alone is satisfied by a table
-- nobody can touch, because a missing GRANT raises the same error class as an
-- RLS denial (TESTING.md §7, third trap). The positive case is what proves the
-- gate is a gate rather than a wall.
select tests.auth_as('bbbbbbbb-0000-4000-8000-000000000002'::uuid, true);
select throws_ok(
	$$insert into rooms (name, owner_id) values ('guestroom', 'bbbbbbbb-0000-4000-8000-000000000002')$$,
	'42501',
	null,
	'ANONYMOUS user cannot create a room (restrictive policy)'
);

select tests.auth_as('bbbbbbbb-0000-4000-8000-000000000002'::uuid, false);
select lives_ok(
	$$insert into rooms (name, owner_id) values ('guestroom', 'bbbbbbbb-0000-4000-8000-000000000002')$$,
	'the SAME user, permanent, CAN create one — so the gate is the claim, not the table'
);

-- You may not create a room owned by someone else.
select throws_ok(
	$$insert into rooms (name, owner_id) values ('notmine', 'aaaaaaaa-0000-4000-8000-000000000001')$$,
	'42501',
	null,
	'cannot create a room owned by another identity'
);

-- ---------------------------------------------------------------------------
-- No client write path beyond creation
-- ---------------------------------------------------------------------------
-- AR-SYNC-3's real claim, enforced by GRANT rather than by which key the server
-- holds. Renames go through the control plane.
select throws_ok(
	$$update rooms set name = 'renamed' where name = 'standup'$$,
	'42501',
	null,
	'a client cannot UPDATE a room'
);

select throws_ok(
	$$delete from rooms where name = 'standup'$$,
	'42501',
	null,
	'a client cannot DELETE a room'
);

-- ...but reading is open: a room is addressable by anyone with the link.
select isnt_empty(
	$$select 1 from rooms where name = 'standup'$$,
	'rooms remain readable, so the denials above are about writes only'
);

select * from finish();
rollback;
