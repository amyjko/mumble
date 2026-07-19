-- Joining a room that ASKS leaves you pending (UX-ID-2, UX-ID-3, AR-CTRL-5).
--
-- Until now this hardcoded `status = 'admitted'`, which is what made admission
-- a behaviour change rather than a migration. Two things change:
--
--   * the caller may send a short hello, which is what the host reviews
--     alongside the name (UX-ID-2). The column has existed and gone unread
--     since the schema was written.
--   * a room with `admission = 'ask'` yields `pending` instead.
--
-- Three exceptions to pending, and each matters:
--   * an EXISTING member keeps whatever status they already hold, so a
--     reload does not send an admitted guest back to the waiting room, and a
--     declined one cannot re-join by refreshing.
--   * the room's OWNER is never held at their own door.
--   * an existing host likewise.
--
-- Still SECURITY DEFINER and still the only write path to room_members:
-- clients hold no insert or update privilege on it, so admission cannot be
-- self-granted (AR-CTRL-7).
drop function if exists public.join_room(citext);
drop function if exists public.join_room(citext, text);

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
		return;   -- no row, no exception: the caller renders 404
	end if;

	select * into existing from room_members
	where room_id = target.id and identity_id = actor;

	if found then
		-- Already known to this room: keep the standing decision. Re-deciding
		-- here would let a declined guest back in by pressing reload.
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
		-- A returning guest may restate their hello while waiting; nothing else
		-- about the row is theirs to change.
		set hello = coalesce(excluded.hello, room_members.hello),
			updated_at = now()
		where room_members.status = 'pending';

	return query
		select target.id, (m.role = 'host'), m.status
		from room_members m
		where m.room_id = target.id and m.identity_id = actor;
end $$;

revoke all on function public.join_room(citext, text) from public;
grant execute on function public.join_room(citext, text) to authenticated;
