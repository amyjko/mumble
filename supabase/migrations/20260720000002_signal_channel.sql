-- Per-peer signalling inboxes, and the policy bug that would have made them
-- decorative (AR-BACKEND-2, AR-BACKEND-6, AR-TRANSPORT-1).
--
-- WebRTC signalling is point-to-point: an offer, an answer, and a burst of ICE
-- candidates that concern exactly two parties. The room channel is a broadcast
-- bus every admitted member reads, and putting signalling on it would hand every
-- member every other member's candidate list. A peer you connect to learns your
-- address anyway; a broadcast tells the lurkers too, and server-reflexive
-- candidates carry a public IP in clear. So: an inbox per peer.
--
-- Topic shape `signal:<room uuid>:<recipient uuid>`, named for its RECIPIENT.
-- The two halves are deliberately asymmetric:
--
--   * READ is the addressee alone. An inbox nobody else can drain is the entire
--     privacy claim.
--   * WRITE is any admitted member of that room, because posting into someone's
--     inbox is precisely how a connection is initiated. This is not a weakness
--     to be tightened later — a policy that let you write only to peers who
--     already knew you would make the first offer impossible.
--
-- ---------------------------------------------------------------------------
--
-- FIRST, though: the room policies over-grant, and this migration would have
-- been theatre without fixing them.
--
-- `room_channel_read` and `room_channel_write` parse segment 2 of the topic and
-- ask `is_admitted_member` about it. They never check segment ONE. Since RLS is
-- permissive-OR, an admitted member of room R therefore passes them for ANY
-- topic whose second segment is R — including `signal:R:<somebody else>` and
-- `guest:R:<a waiting guest>`.
--
-- Measured before writing this, rather than reasoned about:
--
--     member_passes_room_predicate_on_someone_elses_signal_topic | t
--     member_passes_room_predicate_on_a_guest_topic              | t
--
-- So the per-peer inbox below would have been readable by the whole room, and
-- the pre-admission channel already is. UX-ID-3 requires the door conversation
-- be "distinct from in-room chat"; `may_use_guest_topic` enforces that
-- correctly, and then the room policy hands it to every member anyway.
--
-- Scoping both policies to their own prefix closes the signalling hole before
-- it exists and the guest-channel one that already did. `room:<uuid>` is the
-- only shape they were ever meant to cover, so this narrows them to their
-- documented intent rather than changing it.

-- A named predicate rather than inline SQL, and not merely for tidiness: a test
-- asserting an expression it spells out itself passes whether or not the policy
-- contains it. My first version of the pgTAP here did exactly that and was
-- vacuous. Every topic family now has one testable function, and the policies
-- are one-line wrappers.
create or replace function public.may_use_room_topic(topic text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
	select
		topic ~* '^room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		and public.is_admitted_member(split_part(topic, ':', 2)::uuid);
$$;

drop policy if exists room_channel_read on realtime.messages;
create policy room_channel_read on realtime.messages
	for select to authenticated
	using (public.may_use_room_topic(realtime.topic()));

drop policy if exists room_channel_write on realtime.messages;
create policy room_channel_write on realtime.messages
	for insert to authenticated
	with check (public.may_use_room_topic(realtime.topic()));

-- ---------------------------------------------------------------------------

-- `signal:<uuid>:<uuid>`, anchored. Casting is only ever reached for a topic
-- that already matched this, so a policy denies malformed input instead of
-- raising on it.
create or replace function public.signal_topic_shape()
returns text language sql immutable as $$
	select '^signal:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

create or replace function public.may_read_signal_topic(topic text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
	select
		-- Match the WHOLE shape before casting anything. The nullif-then-cast
		-- idiom this started as passes 'also-not' — non-empty is not the same as
		-- well-formed — and `'also-not'::uuid` RAISES, which surfaces to the
		-- client as an error rather than a denial. A pgTAP case for a malformed
		-- topic is what found it.
		topic ~* public.signal_topic_shape()
		-- The addressee, and nobody else. Membership is still required: losing
		-- your place in the room must close your inbox with it.
		and auth.uid() = split_part(topic, ':', 3)::uuid
		and public.is_admitted_member(split_part(topic, ':', 2)::uuid);
$$;

create or replace function public.may_write_signal_topic(topic text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
	select
		topic ~* public.signal_topic_shape()
		-- Any admitted member may post into any member's inbox: that is what
		-- initiating a connection requires. What this does NOT confer is the
		-- ability to read the reply, which goes to the sender's own inbox.
		and public.is_admitted_member(split_part(topic, ':', 2)::uuid);
$$;

create policy signal_channel_read on realtime.messages
	for select to authenticated
	using (public.may_read_signal_topic(realtime.topic()));

create policy signal_channel_write on realtime.messages
	for insert to authenticated
	with check (public.may_write_signal_topic(realtime.topic()));

-- A note on what this does and does not authenticate.
--
-- These policies prove the SENDER is an admitted member of the room. They say
-- nothing about who the sender claims to be inside the payload: a member may
-- post a signal stamped with anyone's `from`. That is not a gap these policies
-- can close, and it is exactly what the signed publish grant exists for — the
-- receiving peer checks the grant's `peer` against the live holder list, not
-- against whatever the envelope asserts.

-- ---------------------------------------------------------------------------
-- The same flaw, where it already shipped.
--
-- `may_use_guest_topic` uses the nullif-then-cast idiom this migration just
-- abandoned, so `guest:not-a-uuid:x` RAISES inside the policy instead of
-- returning false. Nobody had reason to send that, which is exactly why it
-- survived — a denial is a refusal, but a raise is an error, and the two are
-- not the same thing to a client. Fixed here rather than filed, since it is the
-- identical one-line class.
create or replace function public.may_use_guest_topic(topic text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
	select
		topic ~* '^guest:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		and (
			-- The waiting guest themselves.
			exists (
				select 1 from room_members m
				where m.room_id = split_part(topic, ':', 2)::uuid
				  and m.identity_id = auth.uid()
				  and m.identity_id = split_part(topic, ':', 3)::uuid
				  and m.status = 'pending'
			)
			-- ...or a host of that room, who is the other side of it.
			or public.is_host(split_part(topic, ':', 2)::uuid)
		);
$$;

-- ---------------------------------------------------------------------------
-- The door channel, which was riding the hole.
--
-- `20260719000019_knock_notify.sql` announces a knock on `door:<room uuid>` and
-- says so in its own comment: "whose segment 2 is the room, so the existing
-- `room_channel_read` policy already limits it to admitted members." That
-- reliance was deliberate and undocumented anywhere else — scoping the room
-- policies to their prefix, as above, would have silently stopped every host
-- from hearing anyone knock. Admission would have looked broken with no error
-- anywhere.
--
-- So the door gets the policy it should always have had. Two changes of
-- substance, both tightenings:
--
--   * READ is HOSTS, not every admitted member. The knock function's first line
--     is "A knock tells the hosts"; it carried no payload precisely because the
--     audience was wider than the intent. Now the audience matches.
--   * There is deliberately NO client write policy. The knock is announced by
--     the database inside a SECURITY DEFINER function, which bypasses RLS, so
--     no client needs to write here — and under the old room policy ANY
--     admitted member could post to `door:<room>` and forge a knock at a host.
--     That stops being possible.
create or replace function public.may_read_door_topic(topic text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
	select
		topic ~* '^door:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		and public.is_host(split_part(topic, ':', 2)::uuid);
$$;

create policy door_channel_read on realtime.messages
	for select to authenticated
	using (public.may_read_door_topic(realtime.topic()));
