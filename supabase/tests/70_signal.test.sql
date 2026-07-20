-- The signalling inbox, and the topic-prefix hole it exposed (AR-BACKEND-6).
--
-- These assert the policy PREDICATES rather than inserts into
-- realtime.messages, because the predicate is where the logic lives and the
-- policies are one-line wrappers over it. `realtime.topic()` reads a per-request
-- config var that pgTAP cannot set meaningfully, so testing through the policy
-- would test the harness rather than the rule.

begin;
select plan(20);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
	('aaaaaaaa-0000-4000-8000-00000000ff01', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sighost@example.test', '', now(), now(), now()),
	('bbbbbbbb-0000-4000-8000-00000000ff02', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sigmemb@example.test', '', now(), now(), now()),
	('cccccccc-0000-4000-8000-00000000ff03', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sigout@example.test', '', now(), now(), now());

select tests.auth_as('aaaaaaaa-0000-4000-8000-00000000ff01'::uuid);
insert into rooms (name, owner_id) values ('sigroom', 'aaaaaaaa-0000-4000-8000-00000000ff01');

select tests.auth_as('bbbbbbbb-0000-4000-8000-00000000ff02'::uuid, true);
select is((select out_status from public.join_room('sigroom')), 'admitted',
	'the second member is admitted');

-- Topics under test, built from the real room id.
create temporary table t as
select
	'signal:' || r.id::text || ':aaaaaaaa-0000-4000-8000-00000000ff01' as host_inbox,
	'signal:' || r.id::text || ':bbbbbbbb-0000-4000-8000-00000000ff02' as member_inbox,
	'guest:'  || r.id::text || ':cccccccc-0000-4000-8000-00000000ff03' as guest_topic,
	'room:'   || r.id::text                                            as room_topic
from rooms r where r.name = 'sigroom';

-- ---------------------------------------------------------------------------
-- The inbox is private to its addressee. This is the whole point.

select ok(
	public.may_read_signal_topic((select member_inbox from t)),
	'a member drains their OWN inbox'
);

select ok(
	not public.may_read_signal_topic((select host_inbox from t)),
	'a member cannot read another member''s inbox'
);

-- ...but writing to it is open, because that is how a connection starts.
select ok(
	public.may_write_signal_topic((select host_inbox from t)),
	'a member may post INTO another member''s inbox'
);

select ok(
	public.may_write_signal_topic((select member_inbox from t)),
	'and into their own'
);

-- ---------------------------------------------------------------------------
-- The regression this migration exists for.
--
-- The room policies parsed segment 2 and never checked segment 1, so an
-- admitted member passed them for ANY topic whose second segment was their
-- room — including somebody else's signalling inbox and the pre-admission
-- channel. Both were measured true before the fix. RLS is permissive-OR, so
-- these two assertions are what make the private-inbox test above mean
-- anything at all.

select ok(
	not public.may_use_room_topic((select host_inbox from t)),
	'the room policy no longer grants a member someone else''s signal inbox'
);

select ok(
	not public.may_use_room_topic((select guest_topic from t)),
	'the room policy no longer grants a member the pre-admission channel (UX-ID-3)'
);

select ok(
	not public.may_use_room_topic((select 'door:' || r.id::text from rooms r where r.name = 'sigroom')),
	'nor the door channel, which any member could forge a knock on'
);

-- And it still does its actual job.
select ok(
	public.may_use_room_topic((select room_topic from t)),
	'a member still reaches the room topic itself'
);

-- ---------------------------------------------------------------------------
-- An outsider gets nothing in either direction.

select tests.auth_as('cccccccc-0000-4000-8000-00000000ff03'::uuid, true);

select ok(
	not public.may_read_signal_topic((select guest_topic from t)),
	'a non-member cannot read a room''s signalling topic'
);

select ok(
	not public.may_write_signal_topic((select member_inbox from t)),
	'a non-member cannot post into a member''s inbox'
);

-- Not even their own address in a room they do not belong to: membership is
-- required on both sides, so losing your place closes your inbox with it.
select ok(
	not public.may_read_signal_topic(
		(select 'signal:' || r.id::text || ':cccccccc-0000-4000-8000-00000000ff03' from rooms r where r.name = 'sigroom')
	),
	'a non-member cannot read an inbox addressed to themselves'
);

-- ---------------------------------------------------------------------------
-- Malformed topics are refused, not raised on. A cast of garbage to uuid would
-- abort the request rather than deny it.

select ok(
	not public.may_read_signal_topic('signal:not-a-uuid:also-not'),
	'a malformed topic is refused rather than erroring'
);

select ok(
	not public.may_read_signal_topic('signal:'),
	'a truncated topic is refused rather than erroring'
);

-- The same class, where it already shipped: a malformed GUEST topic used to
-- raise inside the policy rather than deny.
select ok(
	not public.may_use_guest_topic('guest:not-a-uuid:also-not'),
	'a malformed guest topic is refused rather than erroring'
);

-- ---------------------------------------------------------------------------
-- The door channel, which was riding the hole the room-policy fix closes.
--
-- knock_notify.sql relied on `room_channel_read` covering `door:<room>`. Without
-- a policy of its own, scoping the room policies would have stopped every host
-- hearing a knock — admission broken, no error anywhere.

select tests.auth_as('aaaaaaaa-0000-4000-8000-00000000ff01'::uuid);
select ok(
	public.may_read_door_topic((select 'door:' || r.id::text from rooms r where r.name = 'sigroom')),
	'a host still hears a knock'
);

select tests.auth_as('bbbbbbbb-0000-4000-8000-00000000ff02'::uuid);
select ok(
	not public.may_read_door_topic((select 'door:' || r.id::text from rooms r where r.name = 'sigroom')),
	'a non-host member does not: the knock says it tells the HOSTS'
);

select tests.auth_as('cccccccc-0000-4000-8000-00000000ff03'::uuid, true);
select ok(
	not public.may_read_door_topic((select 'door:' || r.id::text from rooms r where r.name = 'sigroom')),
	'and an outsider certainly does not'
);

select ok(
	not public.may_read_door_topic('door:not-a-uuid'),
	'a malformed door topic is refused rather than erroring'
);

-- No client may WRITE a knock. The database announces it from inside a
-- SECURITY DEFINER function; under the old room policy any admitted member
-- could post to door:<room> and forge one at a host.
select is(
	(select count(*)::int from pg_policies
	 where schemaname = 'realtime' and tablename = 'messages'
	   and policyname = 'door_channel_write'),
	0,
	'there is no client write policy on the door channel'
);

select * from finish();
rollback;
