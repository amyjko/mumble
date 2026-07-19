-- Admission (UX-ID-2, UX-ID-3, AR-CTRL-5).
--
-- The security half of the feature, asserted where it is actually enforced.
-- A waiting guest being unable to SEE the room is not a courtesy the UI extends
-- — it is RLS, and these are the assertions that would fail if the waiting-room
-- branch were the only thing standing between a pending guest and the canvas.

begin;
select plan(10);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
	('aaaaaaaa-0000-4000-8000-00000000ad01', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'host@example.test', '', now(), now(), now()),
	('bbbbbbbb-0000-4000-8000-00000000ad02', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'waiter@example.test', '', now(), now(), now()),
	('cccccccc-0000-4000-8000-00000000ad03', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stranger@example.test', '', now(), now(), now());

select tests.auth_as('aaaaaaaa-0000-4000-8000-00000000ad01'::uuid);
insert into rooms (name, owner_id) values ('doorroom', 'aaaaaaaa-0000-4000-8000-00000000ad01');

-- Default is OPEN, which every other test in this suite and 65 E2E joins rely
-- on. A room that quietly started asking would strand all of them.
select is(
	(select admission from room_state s join rooms r on r.id = s.room_id where r.name = 'doorroom'),
	'open',
	'a new room is open by default'
);

select tests.auth_as('bbbbbbbb-0000-4000-8000-00000000ad02'::uuid, true);
select is((select out_status from public.join_room('doorroom')), 'admitted',
	'an open room admits a guest outright');

-- Close the door.
--
-- Done as the PRIVILEGED role on purpose: clients hold SELECT and nothing else
-- on room_state (40_state asserts exactly that), so a host cannot write this
-- directly and the route is what does it in the product. Attempting it as the
-- host here would abort the transaction — which it did, and the plan count is
-- what caught it.
set local role postgres;
update room_state set admission = 'ask'
where room_id = (select id from rooms where name = 'doorroom');

-- An already-admitted member is NOT sent back to the waiting room by a reload.
select tests.auth_as('bbbbbbbb-0000-4000-8000-00000000ad02'::uuid, true);
select is((select out_status from public.join_room('doorroom')), 'admitted',
	'an admitted member stays admitted when the door closes behind them');

-- A NEW arrival waits, and their hello is recorded for the host to read.
select tests.auth_as('cccccccc-0000-4000-8000-00000000ad03'::uuid, true);
select is((select out_status from public.join_room('doorroom', 'let me in please')), 'pending',
	'a new arrival at a closed door is pending');
select is(
	(select hello from room_members where identity_id = 'cccccccc-0000-4000-8000-00000000ad03'),
	'let me in please',
	'and their hello is recorded (UX-ID-2)'
);

-- THE security assertion. A pending guest is refused the room's contents by
-- RLS, not by the UI: every state table requires admitted-ness.
select is_empty(
	$$select 1 from room_state where room_id = (select id from rooms where name = 'doorroom')$$,
	'a pending guest cannot read room state'
);
select is_empty(
	$$select 1 from room_objects where room_id = (select id from rooms where name = 'doorroom')$$,
	'nor its objects'
);
select is_empty(
	$$select 1 from room_participants where room_id = (select id from rooms where name = 'doorroom')$$,
	'nor who is in it'
);

-- Nobody may decide their own admission. The route holds the only write path,
-- and it runs as the service role.
select throws_ok(
	$$update room_members set status = 'admitted'
	  where identity_id = 'cccccccc-0000-4000-8000-00000000ad03'$$,
	'42501',
	NULL,
	'a waiting guest cannot admit themselves'
);

-- A declined guest cannot clear the decision by knocking again, which is the
-- difference between a door and a turnstile. The decline itself is the route's
-- write, so it is made here with the route's privilege.
set local role postgres;
update room_members set status = 'declined'
where identity_id = 'cccccccc-0000-4000-8000-00000000ad03';
select tests.auth_as('cccccccc-0000-4000-8000-00000000ad03'::uuid, true);
select is((select out_status from public.join_room('doorroom', 'please?')), 'declined',
	'a declined guest stays declined however often they re-join');

select * from finish();
rollback;
