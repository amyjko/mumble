# The control plane, and what testing found in it

Auth, membership, room state, and the one write path — how they work, and the
defects that shaped them. **Every finding here was produced by a test or a
measurement, not by review**, which is the reason this file exists separately
from [DESIGN.md](DESIGN.md): DESIGN.md records what each requirement claims and
whether it holds, while this records what it cost to find out.

Status lives in DESIGN.md and nowhere else. This file used to open with a
phase-by-phase account of one overnight session and a "what is left" list, and
by the time anyone read it three of its four outstanding items had shipped and
one was flatly wrong — a second status report is a second thing to keep true,
and it lost. Rewritten 2026-07-20 to carry only what does not go stale.

## How it fits together

**Permissions could not become real until state was server-side.** That is the
reframing the whole control plane rests on. `MemoryRoomStore` was `localStorage`
plus `BroadcastChannel` — same browser only — so two people on two laptops
shared nothing, and `actorId` was a string the browser handed us. Every gate was
advisory. Sign-in alone would have given real accounts and changed none of it.

The shape that came out of that:

- **The rule engine is pure and shared.** ~600 lines of permission checks, the
  stage machine and overlap re-validation live in `model/rules.ts`: no storage,
  no transport, no `this`. AR-SYNC-3 wants the *same* rules on client and
  server, and writing them twice would be two sources of truth for exactly the
  rules this project keeps single-sourced.
- **One write path.** `POST /api/rooms/[room]/mutate` takes the mutation union.
  The actor comes from the verified JWT and the role from a membership row read
  server-side, so a request cannot assert who it is or what it may do.
- **Clients hold SELECT and nothing else.** "No write path that bypasses the
  control plane" is delivered by GRANT, not by convention. RLS policies then
  decide what may be read. Both halves are stated explicitly in the migrations,
  because a privilege model you have to infer from what someone did *not* revoke
  is one nobody can review.
- **Optimistic local apply is not optional.** The first version awaited the
  server and re-read the whole room after every commit; it lagged each keystroke
  and destroyed in-flight typing. AR-SYNC-2/3 licence applying locally and
  letting the server arbitrate.

## The expensive one: a stall that read as write volume

**It was never write volume.** A version conflict raised SQLSTATE `40001`, which
PostgREST treats as a TRANSIENT error and retries internally — but a CAS
mismatch is deterministic, so the request stalled until the gateway killed it.
Measured with nothing running concurrently: **60,007 ms** for one stale write,
returning "the upstream server is timing out". The same raise as `PT409` takes
**7 ms**.

Each conflict pinned a pool connection for a full minute, and ten of them
exhausted the 10-connection pool — after which every unrelated request failed
with "Timed out acquiring connection from connection pool". That symptom was
read three times as "we are writing too much", which is why the diff, the worker
count and the CAS granularity were each changed in turn without fixing anything.
The diff was worth having regardless; it was not the cause.

Read it as a method note rather than a war story: **three diagnoses were inferred
from a symptom and none was measured.** The CAS had no test coverage anywhere —
nothing in pgTAP, integration or E2E fired two overlapping requests — so the
`40001` path had never once executed in a test.

## Guarding everything is lossy, not merely slow

Once conflicts were cheap enough to count, the room-wide guard turned out to
LOSE writes: twenty concurrent writers touching twenty DIFFERENT objects, each
retrying three times as the route does, lost **seventeen of twenty**, because one
room-wide counter makes every writer invalidate every other.

So `needsGuard` guards only writes that read what they overwrite — a room scalar
(every stage, capacity, placer and layout write) or a merging mutation
(`edit_note`, `post_message`). Everything else writes disjoint rows, where
last-writer-wins is correct rather than a compromise. Re-measured: **0 lost of
20.**

## Traps that cost a session each

- **`service_role` had no grants** on any state table. The migrations revoked
  from `anon`/`authenticated` and relied on defaults for the writer, which do not
  exist here — so the control plane could not write either, and the failure
  surfaced as a 404.
- **Postgres renders `timestamptz` as `2026-07-19 05:00:00+00`**, and the schema
  demands strict ISO. Every object failed validation on read-back.
- **`generateLink({type:'magiclink'})` on an unknown address creates the user and
  issues a SIGNUP token**, which fails verification as a magiclink with the same
  opaque error a forged link gives.
- **A permission test asserted 403 and got 401.** The canvas mounts before
  anonymous sign-in resolves, so it was testing "no session" while claiming to
  test "wrong role".
- **A cross-room write.** `room_objects.id` and `room_configurations.id` are
  GLOBAL keys, so `on conflict (id) do update` matched rows in OTHER rooms while
  the update list never included `room_id`: a write scoped to room B rewrote room
  A's object and left it filed under room A. Reachable by any authenticated
  member of any room. Conflict actions are now scoped to the same room.
- **The seam's `untrack` guarantee lived in one store.** `applyMutation` reads
  and writes state synchronously inside the committing effect;
  `MemoryRoomStore.commit` wrapped it and called that a guarantee "for every
  store implementation". `SupabaseRoomStore` did not, so a second tab died with
  `effect_update_depth_exceeded` before processing a single broadcast.
- **Identity is two things**: the authenticated id (read from the JWT) and the
  profile (name, emoji). Conflating them meant a visitor with no roamed profile
  kept an older anonymous session's id, so self-checked mutations were refused
  while others succeeded.

## E2E flakiness, twice, and neither cause was the suspected one

**Round one — a client re-reading its own writes.** Six mutates produced six
`get_room_state` calls. The suppression meant to prevent that adopted the
version from the commit's HTTP response, and the broadcast beats that response
back to the browser — the RPC is ~5 ms, the round trip through the worker is not
— so `version` was still stale when the echo arrived and the hydrate fired
anyway.

The cost was not traffic. Each hydrate replaced the whole object graph, so every
derived recomputed, auto-fit re-ran, and the canvas RE-LAID-OUT under whatever
pointer was mid-gesture. That is why failures rotated across unrelated tests and
why they were all hover, click, or measure: **the target moved.** Fixed by having
the broadcast name its writer — a per-TAB client id, not the actor, since two
tabs of one person must still see each other.

A second bug surfaced in the same trace: a hydrate landing while a commit was in
flight replaced state that already contained the optimistic write, and the object
vanished for good, because a commit's echo is suppressed and nothing re-read.
Unconfirmed writes are now re-applied on top of every snapshot. An earlier
attempt dropped snapshots whenever anything was in flight, which starved peer
updates entirely while anyone was typing.

**Round two — two causes, one of them a product bug.**

1. **`ensureSession` raced with itself and minted two anonymous users per
   browser.** It was a bare check-then-act, and the room page calls it twice BY
   DESIGN: once on mount so an account holder fetches their roaming profile, once
   more when the join prompt supplies a hello. The page's own comment said that
   was safe because "join_room is idempotent" — true, but idempotent PER
   IDENTITY, and the race gave the two knocks different ones. Confirmed in
   Postgres: two `room_members` rows, two anonymous users, 62 ms apart, one
   nameless. Fixed with a single-flight promise, the session check INSIDE it
   rather than in front. **This was a product bug, not a test bug**: at an "ask
   first" door the host saw one arrival twice, once as a "Someone" who could
   never be matched to a person, and the phantom row stayed pending forever.
2. **Two tests navigated before their own write had settled.** A trace's network
   log showed `POST -1 .../mutate` — the request ABORTED. "Objects survive a
   reload" clicked `+ note`, asserted the frame (which is the OPTIMISTIC one and
   appears before the write leaves the browser), then reloaded — killing its own
   in-flight POST, so there was correctly nothing to restore. `settled()` exists
   for exactly this and both tests predated it. Only reproduced in parallel,
   because that is when the round trip finally outlasts the render.

## Method notes worth keeping

- **Capture the artefact first.** Three rounds of reasoning cost more than one
  Playwright trace.
- **Instrumentation is not free.** The single worst run measured (8 failures) was
  polluted by diagnostics that rebuilt an array on every render. A measurement
  taken through instrumentation is not a measurement of the system.
- **An exhausted pool POISONS later runs.** Two full-suite results were drawn
  against a degraded stack before anyone noticed the environment was being
  measured rather than the change. Restart Supabase before trusting a suite
  result that follows a failing one.
- **A coincidence of sampling looks like a fix.** A worker-count cap looked like
  the answer for a while — 4 workers green, 7 flaky. After the two real fixes
  both counts were green and no config change was needed.
- **The store must be built ONCE per room**, with the actor set afterwards.
  Taking `actorId` as a constructor argument made it a `$derived` on identity,
  which rebuilt the store and its Realtime channel every time anonymous sign-in,
  the join RPC, or a roamed profile landed.
- **Scope a count to what it is about.** Ledger pgTAP assertions counted
  `usage_ledger` globally; they passed alone and failed in the full suite,
  because pgTAP rolls back while the integration and E2E layers commit to the
  same database.

## Design notes still standing

- Hydrate via one RPC returning the whole `RoomState`, parsed by
  `roomStateSchema` — one round trip, one consistent snapshot.
- Broadcast-from-Database (`realtime.broadcast_changes()`), never Postgres
  Changes (AR-BACKEND-3's standing guardrail). **Still outstanding**: the
  fan-out is issued by the route today, not by a trigger (AR-BACKEND-4).
- Three rules the remote-apply path must hold: drop any broadcast with
  `version <= local`; re-hydrate on a version GAP (Realtime is at-most-once);
  and merge Yjs docs rather than replacing them, or you discard whatever this
  client typed since the sender's write.
- Realtime caps messages around 256 KB. Drawings, not notes, are the risk —
  measured: a 500-char note is 0.5 KB. Build notify-and-fetch from the start.

Running the suites: see [README.md](README.md), which owns that list.
