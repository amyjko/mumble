-- Joining a room (AR-CTRL-7, UX-ROOM-1).
--
-- Clients hold no write privilege on room_members — that is the point of the
-- GRANT model — so joining cannot be a client INSERT. It is a SECURITY DEFINER
-- function instead of a server route because the rule is small, entirely about
-- rows, and belongs next to the policies it cooperates with.

create or replace function public.join_room(p_name citext)
-- OUT parameters are plpgsql VARIABLES, so naming one `room_id` makes every
-- later reference to a room_id COLUMN ambiguous. Prefixed rather than relying
-- on qualification, which is easy to get right once and forget later.
returns table (out_room_id uuid, out_is_host boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
	target rooms%rowtype;
	actor uuid := auth.uid();
begin
	if actor is null then
		raise exception 'not signed in' using errcode = '42501';
	end if;

	select * into target from rooms where name = p_name;
	if not found then
		-- No row, no exception: "this room does not exist" is a normal answer
		-- the caller renders as a 404, not an error condition.
		return;
	end if;

	-- Idempotent: revisiting a room must not disturb an existing role. A host
	-- who reloads the page stays a host, which an unconditional upsert with a
	-- default role would quietly undo.
	insert into room_members (room_id, identity_id, role, status)
	values (target.id, actor, 'participant', 'admitted')
	on conflict (room_id, identity_id) do nothing;

	return query
		select target.id, (m.role = 'host')
		from room_members m
		where m.room_id = target.id and m.identity_id = actor;
end $$;

revoke all on function public.join_room(citext) from public;
grant execute on function public.join_room(citext) to authenticated;
