-- A knock tells the hosts (UX-ID-3, AR-CTRL-5).
--
-- Without this a waiting guest is invisible until a host happens to reopen the
-- settings panel, which is the failure that makes a door worse than no door.
--
-- Announced by the DATABASE rather than by the guest, because a pending guest
-- holds no write privilege on any of this room's channels — and handing them
-- one so they could ring a bell would be a hole in the gate they are waiting
-- at. The topic is `door:<room uuid>`, whose segment 2 is the room, so the
-- existing `room_channel_read` policy already limits it to admitted members.
--
-- The ping carries NO payload. The host's list re-reads `room_members` under
-- RLS instead, so a waiting guest's name and hello never ride a channel that
-- every admitted member of the room can read.
create or replace function public.join_room(p_name citext, p_hello text default null)
returns table (out_room_id uuid, out_is_host boolean, out_status text)
language plpgsql
security definer
set search_path = public
as $$
declare
	target rooms%rowtype;
	actor uuid := auth.uid();
	existing room_members%rowtype;
	asks boolean;
	next_status text;
begin
	if actor is null then
		raise exception 'not signed in' using errcode = '42501';
	end if;

	select * into target from rooms where name = p_name;
	if not found then
		return;
	end if;

	select * into existing from room_members
	where room_id = target.id and identity_id = actor;

	if found then
		next_status := existing.status;
	else
		select (s.admission = 'ask') into asks from room_state s where s.room_id = target.id;
		next_status := case
			when coalesce(asks, false) and target.owner_id <> actor then 'pending'
			else 'admitted'
		end;
	end if;

	insert into room_members (room_id, identity_id, role, status, hello)
	values (target.id, actor, 'participant', next_status, nullif(btrim(coalesce(p_hello, '')), ''))
	on conflict (room_id, identity_id) do update
		set hello = coalesce(excluded.hello, room_members.hello),
			updated_at = now()
		where room_members.status = 'pending';

	if next_status = 'pending' then
		perform realtime.send(
			'{}'::jsonb, 'knock', 'door:' || target.id::text, true
		);
	end if;

	return query
		select target.id, (m.role = 'host'), m.status
		from room_members m
		where m.room_id = target.id and m.identity_id = actor;
end $$;

revoke all on function public.join_room(citext, text) from public;
grant execute on function public.join_room(citext, text) to authenticated;
