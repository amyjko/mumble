-- The reserved list grows, because rooms moved to the root (UX-ROOM-8/9).
--
-- 20260719000001_rooms.sql seeded fifteen names and could afford to: rooms lived
-- at `/hey/<name>`, so no room name could collide with a top-level route however
-- it was spelled, and the list only had to cover words we might want under the
-- prefix. The prefix is gone as of 2026-07-21 — `mumble.studio/lci` rather than
-- `mumble.studio/hey/lci`, because the address is the thing people say out loud
-- — and that containment went with it.
--
-- So the list is now deliberately over-broad: every live route, everything
-- served out of static/ before a route is consulted, the marketing and billing
-- surface a product this age grows next, the legal pages, and the product's own
-- vocabulary. Reserving a word costs one name nobody has asked for. Failing to
-- reserve one costs a route we cannot ship without evicting someone from an
-- address they have been reading aloud for a year.
--
-- Mirrors RESERVED_NAMES in src/lib/model/room-name.ts, same grouping and same
-- reasons; reserved-names.spec.ts compares the two sets across ALL migrations,
-- because the failure mode is silent in both directions.
--
-- No schema change is needed. `reserved_room_names` and the
-- `rooms_reject_reserved` trigger already do the work, and the trigger fires
-- `before insert or update of name`, so an existing room is left alone while any
-- future rename is checked against the wider list.
--
-- `on conflict do nothing` because the original fifteen are all still here.
insert into reserved_room_names (name) values
	-- Live routes and their obvious aliases.
	('account'), ('api'), ('auth'), ('login'), ('logout'), ('new'),
	('oauth'), ('signin'), ('signout'), ('signup'),
	-- Served from static/ or by convention, before any route is consulted.
	('assets'), ('cdn'), ('favicon'), ('fonts'), ('img'), ('robots'),
	('rss'), ('static'), ('well-known'),
	-- The marketing and support surface a product this age grows next.
	('about'), ('blog'), ('careers'), ('changelog'), ('contact'), ('demo'),
	('desktop'), ('docs'), ('download'), ('enterprise'), ('faq'), ('feed'),
	('help'), ('home'), ('news'), ('pricing'), ('security'), ('status'),
	('support'), ('team'),
	-- Money and account management (UX-ECON).
	('billing'), ('dashboard'), ('pro'), ('settings'), ('upgrade'),
	-- Legal.
	('cookies'), ('legal'), ('privacy'), ('terms'),
	-- The product's own vocabulary — DESIGN.md's nouns, which would read as
	-- documentation rather than as somebody's standup.
	('house'), ('houses'), ('mumble'), ('room'), ('rooms'), ('studio'),
	-- The address scheme rooms used to live under; a room AT /hey would be a
	-- confusing echo of the prefix this change retired.
	('hey'),
	-- Anything that would be actively confusing, ambiguous, or a footgun to
	-- hand out as an address.
	('admin'), ('embed'), ('explore'), ('invite'), ('join'), ('me'),
	('profile'), ('public'), ('search'), ('user'), ('users'), ('ws'),
	('you'), ('null'), ('undefined')
on conflict (name) do nothing;
