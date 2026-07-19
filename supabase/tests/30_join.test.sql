-- Joining (AR-CTRL-7).

begin;
select plan(6);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
	('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@example.test', '', now(), now(), now()),
	('bbbbbbbb-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'guest@example.test', '', now(), now(), now());

select tests.auth_as('aaaaaaaa-0000-4000-8000-000000000001'::uuid);
insert into rooms (name, owner_id) values ('standup', 'aaaaaaaa-0000-4000-8000-000000000001');

-- The owner is a host, and joining their own room does not demote them. An
-- unconditional upsert with the default role would, and the failure would look
-- like "the host lost their controls after a refresh".
select is((select out_is_host from public.join_room('standup')), true, 'the owner joins as host');
select is((select out_is_host from public.join_room('standup')), true, 'and stays host on a second join');

-- A guest — anonymous, since that is the common case — becomes a participant.
select tests.auth_as('bbbbbbbb-0000-4000-8000-000000000002'::uuid, true);
select is((select out_is_host from public.join_room('standup')), false, 'an anonymous guest joins as participant');
select isnt_empty($$select 1 from room_members where identity_id = 'bbbbbbbb-0000-4000-8000-000000000002'$$,
	'and the membership row exists');

-- An unknown room is an empty result, not an error: the caller renders 404.
select is_empty($$select * from public.join_room('nosuchroom')$$, 'an unknown room returns no rows');

-- Signed out, joining is refused outright.
select tests.logout();
select throws_ok($$select * from public.join_room('standup')$$, '42501', null, 'signed out cannot join');

select * from finish();
rollback;
