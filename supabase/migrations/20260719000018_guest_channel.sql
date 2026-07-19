-- The pre-admission channel, one per waiting guest (AR-BACKEND-6, AR-CTRL-5).
--
-- UX-ID-3 requires a host to be able to talk to someone at the door, over a
-- channel "distinct from in-room chat" — a waiting guest must not see the room,
-- and the room's RLS already guarantees that: every state table and the room
-- channel itself require `is_admitted_member`, which a pending guest fails by
-- definition. So they need a channel of their own.
--
-- Topic shape: `guest:<room uuid>:<guest uuid>`. The room stays in segment 2,
-- which is what the existing room policies parse, so a guest topic simply fails
-- their `is_admitted_member` check rather than erroring on a bad cast.
-- Postgres RLS is permissive-OR, so these two policies grant access the room
-- ones deny without weakening them.
--
-- Who may use a guest topic:
--   * the guest named in segment 3, and only while they are actually PENDING —
--     once admitted or declined the conversation is over, and an admitted
--     participant belongs on the room channel;
--   * any HOST of that room, which is what makes it a conversation.
create or replace function public.may_use_guest_topic(topic text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
	select
		-- Shape check first: a topic that is not `guest:<uuid>:<uuid>` is not
		-- ours to judge, and casting garbage to uuid would raise rather than
		-- return false.
		split_part(topic, ':', 1) = 'guest'
		and nullif(split_part(topic, ':', 2), '') is not null
		and nullif(split_part(topic, ':', 3), '') is not null
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

create policy guest_channel_read on realtime.messages
	for select to authenticated
	using (public.may_use_guest_topic(realtime.topic()));

create policy guest_channel_write on realtime.messages
	for insert to authenticated
	with check (public.may_use_guest_topic(realtime.topic()));
