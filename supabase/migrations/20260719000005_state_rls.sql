-- RLS for canvas state (AR-SYNC-3, UX-ROOM-3, AR-TEST-5).
--
-- Clients get SELECT and NOTHING ELSE on every one of these. That is what makes
-- "clients hold no write path that bypasses the control plane" a property
-- pgTAP can prove, rather than a convention that depends on which key the
-- server happens to hold.

alter table room_state enable row level security;
alter table room_objects enable row level security;
alter table room_participants enable row level security;
alter table room_configurations enable row level security;
alter table participant_locations enable row level security;

revoke all on room_state, room_objects, room_participants, room_configurations, participant_locations
	from anon, authenticated;
grant select on room_state, room_objects, room_participants, room_configurations, participant_locations
	to anon, authenticated;

create policy room_state_select on room_state
	for select to authenticated using (public.is_admitted_member(room_id));

create policy room_participants_select on room_participants
	for select to authenticated using (public.is_admitted_member(room_id));

create policy room_configurations_select on room_configurations
	for select to authenticated using (public.is_admitted_member(room_id));

create policy participant_locations_select on participant_locations
	for select to authenticated using (public.is_admitted_member(room_id));

-- UX-ROOM-3's hiding rule, in SQL.
--
-- This is the ONE place fine-grained permission logic must be duplicated out of
-- TypeScript: `canSee` runs in the client for responsiveness, but a client
-- reading rows directly is a real path, and a hidden object that arrives over
-- the wire is not hidden. Everything else (canEdit, the overlap solver, the
-- stage machine) stays in the rule engine and runs server-side there.
create policy room_objects_select on room_objects
	for select to authenticated
	using (
		public.is_admitted_member(room_id)
		and (
			hidden is false
			or creator_id = auth.uid()
			or public.is_host(room_id)
		)
	);
