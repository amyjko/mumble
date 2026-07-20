-- Image storage RLS (UX-OBJ-5, AR-BACKEND-1, AR-TEST-5).
--
-- The bytes of an image live in Storage, not Postgres, but they must ride the
-- SAME room-membership gate as every object (room_objects_select in 40_state).
-- These tests prove that behaviourally on `storage.objects`: an admitted member
-- may write and read under their room's path prefix; a non-member and anon may
-- do neither.
--
-- The bucket's own byte and mime limits are enforced by the Storage API, not by
-- an SQL policy, so they are not testable here — they live in the upload-helper
-- browser spec. What IS an SQL fact is who may touch the row at all.

begin;
select plan(6);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
	('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'host@example.test', '', now(), now(), now()),
	('bbbbbbbb-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'member@example.test', '', now(), now(), now()),
	('cccccccc-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@example.test', '', now(), now(), now());

-- Host creates the room (and becomes its first admitted member by trigger);
-- a second user is added as an admitted participant.
select tests.auth_as('aaaaaaaa-0000-4000-8000-000000000001'::uuid);
insert into rooms (name, owner_id) values ('demo', 'aaaaaaaa-0000-4000-8000-000000000001');

set local role postgres;
insert into room_members (room_id, identity_id, role)
	values ((select id from rooms where name = 'demo'), 'bbbbbbbb-0000-4000-8000-000000000002', 'participant');

-- The bucket exists, created by the migration rather than by any client.
select isnt_empty(
	$$select 1 from storage.buckets where id = 'room-images' and public is false$$,
	'the room-images bucket exists and is private');

-- An admitted member may upload under their room's prefix.
select tests.auth_as('bbbbbbbb-0000-4000-8000-000000000002'::uuid);
select lives_ok(
	$$insert into storage.objects (bucket_id, name, owner)
	  select 'room-images', (select id from rooms where name = 'demo') || '/pic.png', auth.uid()$$,
	'an admitted member can upload an image under their room prefix');

-- ...and read it back.
select is(
	(select count(*) from storage.objects where bucket_id = 'room-images')::int,
	1,
	'an admitted member can read images in their room');

-- An outsider (authenticated but not a member) can do neither.
select tests.auth_as('cccccccc-0000-4000-8000-000000000003'::uuid);
select throws_ok(
	$$insert into storage.objects (bucket_id, name, owner)
	  select 'room-images', (select id from rooms where name = 'demo') || '/sneaky.png', auth.uid()$$,
	'42501', null, 'a non-member cannot upload into a room they are not in');
select is_empty(
	$$select 1 from storage.objects where bucket_id = 'room-images'$$,
	'a non-member cannot read the room''s images');

-- An unauthenticated caller is refused the same read.
select tests.logout();
select is_empty(
	$$select 1 from storage.objects where bucket_id = 'room-images'$$,
	'an unauthenticated caller cannot read the room''s images');

select * from finish();
rollback;
