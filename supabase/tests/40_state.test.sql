-- Canvas state visibility (UX-ROOM-3, AR-SYNC-3).

begin;
select plan(9);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
	('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'host@example.test', '', now(), now(), now()),
	('bbbbbbbb-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'guest@example.test', '', now(), now(), now()),
	('cccccccc-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@example.test', '', now(), now(), now());

select tests.auth_as('aaaaaaaa-0000-4000-8000-000000000001'::uuid);
insert into rooms (name, owner_id) values ('demo', 'aaaaaaaa-0000-4000-8000-000000000001');

-- Seeded by trigger, so no code path meets a room without state.
select isnt_empty($$select 1 from room_state$$, 'a new room gets its state row');

-- Two objects by the GUEST: one visible, one hidden.
set local role postgres;
insert into room_members (room_id, identity_id, role)
	values ((select id from rooms where name = 'demo'), 'bbbbbbbb-0000-4000-8000-000000000002', 'participant');
insert into room_members (room_id, identity_id, role)
	values ((select id from rooms where name = 'demo'), 'cccccccc-0000-4000-8000-000000000003', 'participant');
insert into room_objects (id, room_id, type, creator_id, hidden, transform, clip, border)
values
	('11111111-1111-4111-8111-111111111111', (select id from rooms where name = 'demo'), 'note', 'bbbbbbbb-0000-4000-8000-000000000002', false, '{}', '{}', '{}'),
	('22222222-2222-4222-8222-222222222222', (select id from rooms where name = 'demo'), 'note', 'bbbbbbbb-0000-4000-8000-000000000002', true,  '{}', '{}', '{}');

-- The creator sees their own hidden object.
select tests.auth_as('bbbbbbbb-0000-4000-8000-000000000002'::uuid, true);
select is((select count(*) from room_objects)::int, 2, 'the creator sees their hidden object');

-- Another participant does NOT. This is UX-ROOM-3, and it is the reason the
-- objects are rows: RLS cannot hide part of a JSONB document.
select tests.auth_as('cccccccc-0000-4000-8000-000000000003'::uuid, true);
select is((select count(*) from room_objects)::int, 1, 'another participant sees only the visible one');
select is_empty($$select 1 from room_objects where hidden$$, 'and cannot reach the hidden row at all');

-- A HOST sees it, which is the half that had never run in the product.
select tests.auth_as('aaaaaaaa-0000-4000-8000-000000000001'::uuid);
select is((select count(*) from room_objects)::int, 2, 'a host sees hidden objects (UX-ROOM-3)');

-- No client write path anywhere. Paired with a positive read, because a
-- missing GRANT and an RLS denial raise the same error class.
select throws_ok(
	$$insert into room_objects (id, room_id, type, creator_id, transform, clip, border)
	  values (gen_random_uuid(), (select id from rooms where name = 'demo'), 'note', auth.uid(), '{}', '{}', '{}')$$,
	'42501', null, 'a client cannot INSERT an object');
select throws_ok(
	$$update room_objects set hidden = false where hidden$$,
	'42501', null, 'a client cannot UPDATE an object');
select throws_ok(
	$$update room_state set max_av = 99$$,
	'42501', null, 'a client cannot UPDATE room state');
select isnt_empty($$select 1 from room_state$$, '...while still being able to READ it');

select * from finish();
rollback;
