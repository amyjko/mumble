-- Avatar identity (UX-ID-6, UX-ID-9).

begin;
select plan(6);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
	('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@example.test', '', now(), now(), now()),
	('bbbbbbbb-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@example.test', '', now(), now(), now());

select tests.auth_as('aaaaaaaa-0000-4000-8000-000000000001'::uuid);
select lives_ok(
	$$insert into profiles (id, name, emoji) values ('aaaaaaaa-0000-4000-8000-000000000001', 'Ada', '🐢')$$,
	'you may create your own profile'
);
select lives_ok(
	$$update profiles set name = 'Ada L' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
	'and update it'
);

-- The gate: someone else's face is not yours to change.
select throws_ok(
	$$insert into profiles (id, name, emoji) values ('bbbbbbbb-0000-4000-8000-000000000002', 'Not Me', '🦊')$$,
	'42501', null, 'you cannot create a profile for another identity'
);

set local role postgres;
insert into profiles (id, name, emoji) values ('bbbbbbbb-0000-4000-8000-000000000002', 'Bob', '🦊');
select tests.auth_as('aaaaaaaa-0000-4000-8000-000000000001'::uuid);

select is(
	(select count(*) from profiles where id = 'bbbbbbbb-0000-4000-8000-000000000002' and name = 'Bob')::int,
	1, 'you can READ another profile — names are public inside a room anyway'
);
-- ...but not rewrite it. RLS UPDATE with a failing USING clause matches no
-- rows rather than erroring, so this asserts the ROW, not an exception.
update profiles set name = 'Hijacked' where id = 'bbbbbbbb-0000-4000-8000-000000000002';
select is(
	(select name from profiles where id = 'bbbbbbbb-0000-4000-8000-000000000002'),
	'Bob', 'and cannot rewrite it'
);

-- An anonymous user gets a profile like anyone else: the boundary is the
-- ACCOUNT (browser-bound, AR-AUTH-6), not the storage.
select tests.auth_as('bbbbbbbb-0000-4000-8000-000000000002'::uuid, true);
select lives_ok(
	$$update profiles set emoji = '🐙' where id = 'bbbbbbbb-0000-4000-8000-000000000002'$$,
	'an ANONYMOUS user may keep a profile too — one code path'
);

select * from finish();
rollback;
