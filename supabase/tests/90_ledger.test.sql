-- The ledger, the weekly roll and who pays (AR-COST-2..4, AR-COST-6, UX-ECON-2,
-- UX-ID-4, AR-TEST-5).
--
-- Two claims are proved here, and they are the two that would be expensive to
-- get wrong silently:
--
--   1. WHO PAYS. A guest's seconds land on the ROOM OWNER's account and on no
--      other. This is UX-ID-4, and it is the assertion that would catch
--      attribution quietly reverting to "whoever was present" — a change that
--      breaks nothing visible and makes every guest-heavy room free.
--   2. NOBODY MAY WRITE THEIR OWN METER. A client that could add to its counter
--      could also subtract from it, at which point the cap is decorative.
--
-- The roll's arithmetic is tested at its awkward case rather than its easy one:
-- an account stale by a WHOLE number of weeks. That case is where the first
-- implementation was wrong (it advanced the boundary to exactly `now()`, which
-- still reads as due, so the next read zeroed a live week).

begin;
select plan(15);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
	('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'host@example.test', '', now(), now(), now()),
	('bbbbbbbb-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'guest@example.test', '', now(), now(), now());

-- ---------------------------------------------------------------------------
-- An account exists for everyone, without anyone asking
-- ---------------------------------------------------------------------------
select is(
	(select count(*) from accounts where id in (
		'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'))::int,
	2, 'creating a user creates their account, by trigger');

select is(
	(select weekly_cap_seconds from accounts where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
	36000, 'the default weekly budget is ten hours');

-- ---------------------------------------------------------------------------
-- Who pays (UX-ID-4)
-- ---------------------------------------------------------------------------
select tests.auth_as('aaaaaaaa-0000-4000-8000-000000000001'::uuid);
insert into rooms (name, owner_id) values ('lci', 'aaaaaaaa-0000-4000-8000-000000000001');

set local role postgres;
select public.meter_seconds((select id from rooms where name = 'lci'), 'bbbbbbbb-0000-4000-8000-000000000002', 15);
select public.meter_seconds((select id from rooms where name = 'lci'), 'bbbbbbbb-0000-4000-8000-000000000002', 15);

select is(
	(select weekly_seconds_used from accounts where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
	30, 'a GUEST''s seconds accrue to the room OWNER');
select is(
	(select weekly_seconds_used from accounts where id = 'bbbbbbbb-0000-4000-8000-000000000002'),
	0, 'and never to the guest''s own account');

-- One open interval per person per room, accumulating — not a row per beat,
-- which at a 15s cadence would be 240 rows per person per hour.
--
-- SCOPED TO THIS ROOM, every one of them. These ran unscoped first and passed
-- alone, then failed in the full suite: pgTAP rolls back its own transaction,
-- but the integration and E2E layers run against the same database and COMMIT,
-- so an unscoped `count(*)` here counts their rooms too. A test whose result
-- depends on which other suites ran before it is not measuring what it says.
select is(
	(select count(*) from usage_ledger
	 where left_at is null and room_id = (select id from rooms where name = 'lci'))::int,
	1, 'repeated beats extend ONE open ledger row rather than appending');
select is(
	(select seconds from usage_ledger
	 where left_at is null and room_id = (select id from rooms where name = 'lci')),
	30, 'and that row carries the running total');

-- Leaving closes the interval; coming back opens a new one rather than
-- reviving the old, so the trail reads as two visits and not one long one.
select public.close_ledger_rows((select id from rooms where name = 'lci'), array['bbbbbbbb-0000-4000-8000-000000000002']::uuid[]);
select public.meter_seconds((select id from rooms where name = 'lci'), 'bbbbbbbb-0000-4000-8000-000000000002', 7);
select is(
	(select count(*) from usage_ledger
	 where room_id = (select id from rooms where name = 'lci'))::int,
	2, 'leaving and returning is two intervals, not one');
select is(
	(select sum(seconds)::int from usage_ledger
	 where room_id = (select id from rooms where name = 'lci')),
	37, 'and no seconds are lost across the boundary');

-- A nonsense credit changes nothing. Guards the clamp's edge: the heartbeat
-- computes an elapsed time, and a clock that jumps backwards must not refund.
select public.meter_seconds((select id from rooms where name = 'lci'), 'bbbbbbbb-0000-4000-8000-000000000002', -600);
select is(
	(select weekly_seconds_used from accounts where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
	37, 'a negative credit is refused, so a backwards clock cannot refund time');

-- ---------------------------------------------------------------------------
-- The weekly roll (AR-COST-6)
-- ---------------------------------------------------------------------------
-- Exactly three weeks stale: the case `ceil` gets wrong.
update accounts set weekly_seconds_used = 500, week_resets_at = now() - interval '3 weeks'
	where id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is(
	(select weekly_seconds_used from public.roll_account('aaaaaaaa-0000-4000-8000-000000000001')),
	0, 'reading a stale account rolls its counter to zero');
select ok(
	(select week_resets_at from accounts where id = 'aaaaaaaa-0000-4000-8000-000000000001') > now(),
	'and lands the boundary strictly in the FUTURE, not on now()');

-- The second read must be a no-op. This is the assertion that fails against
-- the ceil implementation, and it fails by erasing real usage.
update accounts set weekly_seconds_used = 42 where id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is(
	(select weekly_seconds_used from public.roll_account('aaaaaaaa-0000-4000-8000-000000000001')),
	42, 'a second read does NOT roll again and does not erase the week''s usage');

-- ---------------------------------------------------------------------------
-- Nobody may write their own meter
-- ---------------------------------------------------------------------------
select tests.auth_as('aaaaaaaa-0000-4000-8000-000000000001'::uuid);
select is(
	(select weekly_seconds_used from accounts where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
	42, 'you may READ your own budget');

select throws_ok(
	$$update accounts set weekly_seconds_used = 0 where id = auth.uid()$$,
	'42501', null, 'but you may not zero it — the cap would be decorative');

-- The ledger is not client-readable at all: nothing renders it, and a room's
-- attendance history is more than reading a budget requires.
select throws_ok(
	$$select 1 from usage_ledger$$,
	'42501', null, 'and the attendance trail is not client-readable');

select * from finish();
rollback;
