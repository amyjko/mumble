-- The control plane's privileges (AR-SYNC-3, AR-CTRL-1).
--
-- The write side of the GRANT model, and it was missing: the earlier migrations
-- revoked from `anon` and `authenticated` but never granted to `service_role`,
-- which was relying on Supabase's default privileges. It does not have them for
-- these tables, so the server could not write either — every mutation came back
-- "permission denied for table rooms", read by the route as a missing room and
-- reported as a 404.
--
-- Stating both halves explicitly is the point. A privilege model you have to
-- infer from what someone did NOT revoke is one nobody can review.
grant select, insert, update, delete on
	rooms,
	room_members,
	room_state,
	room_objects,
	room_participants,
	room_configurations,
	participant_locations
	to service_role;

grant select on reserved_room_names to service_role;

-- service_role bypasses RLS by design; these grants are what let it act at all.
-- Clients keep SELECT and nothing else, which is what makes "clients hold no
-- write path" true by privilege rather than by convention.
