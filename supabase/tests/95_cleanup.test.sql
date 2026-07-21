-- What happens to a person's traces when they stop existing (AR-CTRL-6,
-- AR-AUTH-3), and what happens to a knock nobody answers (AR-CTRL-5).
--
-- The theme is the same in both halves: rows that outlive their reason. An
-- anonymous identity gets cleaned up eventually, and a guest gives up waiting;
-- neither should leave anything behind that a later reader has to interpret.
--
-- The interesting assertion is the CONTRAST — a remembered seat cascades away
-- with its owner, and a ledger row does NOT. Both are keyed on `identity_id`
-- and they behave oppositely on purpose, which is exactly the kind of pair a
-- future migration "tidies" into consistency without noticing it is deleting an
-- audit trail.

begin;
select plan(7);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
	('aaaaaaaa-0000-4000-8000-0000000c1e01', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@example.test', '', now(), now(), now()),
	('bbbbbbbb-0000-4000-8000-0000000c1e02', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'guest@example.test', '', now(), now(), now());

select tests.auth_as('aaaaaaaa-0000-4000-8000-0000000c1e01'::uuid);
insert into rooms (name, owner_id) values ('cleanup', 'aaaaaaaa-0000-4000-8000-0000000c1e01');

set local role postgres;

-- A guest who sat somewhere, and whose time was metered.
insert into participant_locations (room_id, identity_id, config_key, x, y)
values ((select id from rooms where name = 'cleanup'), 'bbbbbbbb-0000-4000-8000-0000000c1e02', 'default', 10, 20);

select public.meter_seconds(
	(select id from rooms where name = 'cleanup'),
	'bbbbbbbb-0000-4000-8000-0000000c1e02',
	30);

select is(
	(select count(*)::int from participant_locations
	 where identity_id = 'bbbbbbbb-0000-4000-8000-0000000c1e02'),
	1, 'the guest has a remembered seat');
select is(
	(select count(*)::int from usage_ledger
	 where identity_id = 'bbbbbbbb-0000-4000-8000-0000000c1e02'),
	1, 'and a ledger row recording their visit');

-- The cleanup job's effect (AR-AUTH-3), simulated by the deletion it will do.
delete from auth.users where id = 'bbbbbbbb-0000-4000-8000-0000000c1e02';

select is(
	(select count(*)::int from participant_locations
	 where identity_id = 'bbbbbbbb-0000-4000-8000-0000000c1e02'),
	0, 'deleting the identity takes the remembered seat with it (AR-CTRL-6)');

-- THE CONTRAST, and the reason this file exists rather than a one-line test.
-- An audit trail must outlive the identity it describes, or the evidence
-- disappears with the guest whose time was billed to somebody else.
select is(
	(select count(*)::int from usage_ledger
	 where identity_id = 'bbbbbbbb-0000-4000-8000-0000000c1e02'),
	1, 'but the ledger row SURVIVES — an audit trail outlives its subject');
select is(
	(select weekly_seconds_used from accounts
	 where id = 'aaaaaaaa-0000-4000-8000-0000000c1e01'),
	30, 'and the seconds stay billed to the owner');

-- ---------------------------------------------------------------------------
-- A knock nobody answers (AR-CTRL-5)
-- ---------------------------------------------------------------------------
-- The sweep itself runs in the heartbeat route, so what is asserted here is the
-- SHAPE it depends on: a pending row carries the clock the sweep reads, and
-- `join_room` refreshes that clock when a waiting guest re-knocks — which is
-- what makes the threshold measure silence rather than patience.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('cccccccc-0000-4000-8000-0000000c1e03', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'waiter@example.test', '', now(), now(), now());

update room_state set admission = 'ask' where room_id = (select id from rooms where name = 'cleanup');

select tests.auth_as('cccccccc-0000-4000-8000-0000000c1e03'::uuid, true);
select is((select out_status from public.join_room('cleanup', 'let me in')), 'pending',
	'a guest at a closed door waits');

set local role postgres;
-- Wind the knock back, as a long silence would.
update room_members set updated_at = now() - interval '31 minutes'
	where identity_id = 'cccccccc-0000-4000-8000-0000000c1e03';

select tests.auth_as('cccccccc-0000-4000-8000-0000000c1e03'::uuid, true);
select public.join_room('cleanup', 'still here');

select ok(
	(select updated_at from room_members
	 where identity_id = 'cccccccc-0000-4000-8000-0000000c1e03') > now() - interval '1 minute',
	're-knocking refreshes the clock, so waiting attentively does not expire');

select * from finish();
rollback;
