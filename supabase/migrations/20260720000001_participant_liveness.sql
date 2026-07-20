-- Liveness for participants (AR-CTRL-3, UX-STAGE-4).
--
-- Presence already reaps a departed holder within a second, and that is the
-- fast path. But it is CLIENT-driven and host-only, so it leaves one hole: a
-- room whose only host has gone keeps its ghosts, and at `max_av = 1` a ghost
-- holds the conch. This is the backstop that needs nobody in particular to be
-- watching.
--
-- `last_seen` deliberately does NOT live in room state. Room state is diffed,
-- versioned and broadcast on every write, so a heartbeat there would be a write
-- and a fan-out per participant every fifteen seconds — turning an idle room
-- into a busy one. It is a column the control plane touches directly, outside
-- the diff path, and nothing renders it.
--
-- This is the liveness half of AR-COST-3's heartbeat. The metering half (join
-- and leave intervals, seconds against a weekly cap) waits for the ledger
-- (AR-COST-2) and can reuse this beat when it lands.
alter table room_participants
	add column if not exists last_seen timestamptz not null default now();

-- The sweep asks "who in this room is stale", so the index leads with the room.
create index if not exists room_participants_last_seen_idx
	on room_participants (room_id, last_seen);
