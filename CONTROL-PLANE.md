# Control plane: what landed, and what is left

Written 2026-07-19, overnight, on branch `overnight/frontend-backlog`.

## The short version

Auth, accounts, the host role, and server-enforced permissions are real. The
canvas still reads and writes the browser stub. Flipping it over is one
reviewable change and is **deliberately not done** — see "What is left".

Every phase below is a separate commit with green CI.

## What changed, and why it mattered

**The reframing.** Permissions could not become real until state was
server-side. `MemoryRoomStore` is `localStorage` + `BroadcastChannel` — *same
browser only* — so two people on two laptops shared nothing, and `actorId` was
a string the browser handed us. Every gate was advisory. Sign-in alone would
have given real accounts and changed nothing about that.

**Phase 1 — the rule engine.** ~600 lines of permission checks, the stage
machine, and overlap re-validation moved out of the store into
`src/lib/model/rules.ts`: no storage, no transport, no `this`. AR-SYNC-3 wants
the *same* rules on client and server; writing them twice would have been two
sources of truth for exactly the rules this project keeps single-sourced. Proof
it was behaviour-preserving: `memory-store.spec.ts` is untouched and its 70
tests pass.

**Phase 2 — schema, RLS, pgTAP.** Rooms and membership, with the tests as part
of the deliverable rather than after it. Both guards are mutation-tested:
flipping `restrictive` → permissive lets an anonymous user create a room
(AR-AUTH-2's footgun, invisible to `policies_are()`), and removing
`SECURITY DEFINER` makes the membership policy recurse into itself — it *hangs*
rather than fails, which is why it is asserted.

**Phase 3 — auth.** Anonymous sessions, magic link, `/new` guarded. `creator_id`
is now the auth user id for guests and account holders alike, one code path.

**Phase 4 — the host role.** Every gate written with a comment promising it
would "light up when the role arrives" now reads a `room_members` row:
`requireHostForRoom` was an empty function with 8 call sites; `canDesignRoom`
was `return true`; `canEdit`/`canSee` took a literal `false` at 8 sites.
UX-PERM-1's `host` branch had never once run in the product.

**Phase 5a — canvas state and the write path.** Tables, RLS, and
`POST /api/rooms/[room]/mutate`. The actor comes from the verified JWT and the
role from a membership row read server-side, so a request cannot assert who it
is. A guest gets 403 from the **server** on a host-only mutation, with the UI
bypassed entirely.

## Four defects found by testing, not review

1. **`service_role` had no grants** on any state table. The migrations revoked
   from `anon`/`authenticated` and relied on defaults for the writer, which do
   not exist here — the control plane could not write either, and the failure
   surfaced as a 404.
2. **Postgres renders `timestamptz` as `2026-07-19 05:00:00+00`**; the schema
   demands strict ISO. Every object failed validation on read-back.
3. **`generateLink({type:'magiclink'})` on an unknown address creates the user
   and issues a SIGNUP token**, which fails verification as a magiclink with the
   same opaque error a forged link gives.
4. **A permission test asserted 403 and got 401** — the canvas mounts before
   anonymous sign-in resolves, so it was testing "no session" while claiming to
   test "wrong role".

## What is left

**Phase 5b — the switchover: DONE** (2026-07-19). The canvas reads and writes
Postgres through `SupabaseRoomStore`. `Room.svelte` takes an injected store,
`/hey/[room]` has a `+page.server.ts` that 404s an absent room and supplies its
uuid, and `DevPanel` is gated on the stub.

### THE blocker, and why three attempts missed it

**It was never write volume.** The version conflict raised SQLSTATE `40001`,
which PostgREST treats as a TRANSIENT error and retries internally — but a CAS
mismatch is deterministic, so the request stalled until the gateway killed it.
Measured with nothing running concurrently: **60,007ms** for one stale write,
returning "the upstream server is timing out". The same raise as `PT409` takes
**7ms**.

Each conflict therefore pinned a pool connection for a full minute, and ten of
them exhausted the 10-connection pool — after which every unrelated request
failed with "Timed out acquiring connection from connection pool". That symptom
was read three times as "we are writing too much", which is why the diff, the
worker count and the CAS granularity were each changed in turn without fixing
anything. The diff was worth having regardless; it was not the cause.

Read this as a method note, not a war story: three diagnoses were inferred from
a symptom and none was measured. The CAS had no test coverage anywhere — nothing
in pgTAP, integration or e2e fired two overlapping requests — so the `40001`
path had never once executed in a test. It now has 13 integration tests,
including a mutation test that removes the guard and confirms a slot grab IS
lost without it.

### The guard is conditional, and that was measured too

Once conflicts were cheap enough to count, guarding everything turned out to be
LOSSY rather than merely slow: twenty concurrent writers touching twenty
DIFFERENT objects, each retrying three times as the route does, lost SEVENTEEN
of their twenty writes, because one room-wide counter makes every writer
invalidate every other. So `needsGuard` guards only writes that read what they
overwrite — a room scalar changed (every stage, capacity, placer and layout
write) or a merging mutation (`edit_note`, `post_message`). Everything else
writes disjoint rows, where last-writer-wins is correct rather than a
compromise. Re-measured after the change: 0 lost of 20.

### Found on the way, each by a test rather than by review

- **A cross-room write.** `room_objects.id` and `room_configurations.id` are
  GLOBAL keys, so `on conflict (id) do update` matched rows in OTHER rooms and
  the update list never included `room_id`: a write scoped to room B rewrote
  room A's object and left it filed under room A. Reachable by any authenticated
  member of any room. Conflict actions are now scoped to the same room.
- **The seam's untrack guarantee lived in one store.** `applyMutation` reads and
  writes state and runs synchronously inside the committing effect;
  `MemoryRoomStore.commit` wraps it in `untrack` and calls that a guarantee "for
  every store implementation". `SupabaseRoomStore` did not, so a second tab died
  with `effect_update_depth_exceeded` before processing a single broadcast.
- **Identity is two things.** The authenticated id (what the server reads from
  the JWT) and the profile (name, emoji). Conflating them meant a visitor with
  no roamed profile kept an older anonymous session's id, so self-checked
  mutations were refused while others succeeded.
- **Two data races** — a stale hydrate response overwriting newer local state,
  and a commit re-hydrating on its own echo. Both read as rendering glitches.

### Still open

- **E2E flakiness — FOUND and fixed (2026-07-19).** 88/88 across six consecutive
  two-worker runs, plus 4 workers and serial. It was never the assertion budget,
  the database, or the concurrency model — three hypotheses measured and
  discarded before a Playwright TRACE of an actual failure showed the mechanism
  in one line: six mutates, six `get_room_state` calls.

  Every write was triggering a full re-read BY THE CLIENT THAT MADE IT. The
  suppression meant to prevent that adopted the version from the commit's HTTP
  response, and the broadcast beats that response back to the browser — the RPC
  is ~5ms, the round trip through the worker is not — so `version` was still
  stale when the echo arrived and the hydrate fired anyway.

  The cost was not traffic. Each hydrate replaced the whole object graph, so
  every derived recomputed, auto-fit re-ran, and the canvas RE-LAID-OUT under
  whatever pointer was mid-gesture. That is why the failures rotated across
  unrelated tests and why they were all hover, click, or measure: the target
  moved. Fixed by having the broadcast name its writer (a per-TAB client id, not
  the actor — two tabs of one person must still see each other) so a client can
  recognise its own echo.

  A second, related bug was found by the same trace and fixed first: a hydrate
  landing while a commit was in flight replaced state that already contained the
  optimistic write, and the object vanished for good, because a commit's echo is
  suppressed and nothing re-read. Unconfirmed writes are now re-applied on top of
  every snapshot. An earlier attempt dropped snapshots whenever anything was in
  flight, which starved peer updates entirely while anyone was typing.

  Method note: three rounds of reasoning cost more than one trace. Capture the
  artefact first next time.

- **E2E flakiness, round two — FOUND and fixed (2026-07-20).** It came back as
  the suite grew: 1–8 failures per full run, rotating across unrelated tests,
  with serial runs green. TWO causes, neither of them the one suspected, and the
  method note above was followed — trace first, then the database.

  **1. `ensureSession` raced with itself and minted two anonymous users per
  browser.** It was a bare check-then-act (`getSession()`, else
  `signInAnonymously()`), and the room page calls it twice BY DESIGN: once on
  mount so an account holder fetches their roaming profile, once more when the
  join prompt supplies a hello. The page's own comment says that is safe because
  "join_room is idempotent" — true, but idempotent PER IDENTITY, and the race
  gave the two knocks different ones. Caught from an admission test failing with
  "strict mode violation: 2 elements" for the Admit button, then confirmed in
  Postgres: two `room_members` rows, two anonymous users, 62ms apart, one of
  them nameless. Fixed with a single-flight promise, the session check INSIDE
  it rather than in front. This was a product bug, not a test bug: at an "ask
  first" door the host saw one arrival twice, once as a "Someone" who could
  never be matched to a person, and the phantom row stayed pending forever.

  **2. Two tests navigated before their own write had settled.** A trace's
  network log showed `POST -1 .../mutate` — the request ABORTED. "Objects
  survive a reload" clicked `+ note`, asserted the frame (which is the
  OPTIMISTIC one, AR-SYNC-2, and appears before the write leaves the browser),
  then reloaded — killing its own in-flight POST, so there was correctly nothing
  to restore. The identity test had the same shape. `settled()` exists for
  exactly this and both tests predated it. Only reproduced in parallel, because
  that is when the round trip finally outlasts the render.

  Result: **8 consecutive green full-suite runs** (119/119), five at the default
  worker count and three at four workers.

  Two method notes, both about being wrong in public. A worker-count cap looked
  like the answer for a while — 4 workers green, 7 flaky — and it was a
  coincidence of sampling; after the two real fixes, both counts are green and
  no config change was needed. And the single worst run measured (8 failures)
  was polluted by MY OWN diagnostics, which rebuilt an array on every render:
  instrumentation is not free, and a measurement taken through it is not a
  measurement of the system.

- **Admission** (UX-ID-3 / AR-CTRL-5) remains deferred by agreement.
- Avatar name/emoji now roam with the profile; the id roams too.

### Also learned

Optimistic local apply is not optional. The first version awaited the server and
then re-read the whole room after every commit; that both lagged each keystroke
and destroyed in-flight typing. AR-SYNC-3's "client-side checks exist only for
responsiveness" is the licence to apply locally and let the server arbitrate,
and `SupabaseRoomStore` now does that.

The store must be built ONCE per room, with the actor set afterwards. Taking
`actorId` as a constructor argument made it a `$derived` on identity, which
rebuilt the store and its Realtime channel every time anonymous sign-in, the
join RPC, or a roamed profile landed.

Three harness defects the attempt exposed are already FIXED and on main-line:
the admin client is memoized on BOTH sides — the server route and the E2E
helper, where a fresh client per call meant a fresh connection pool per call —
E2E uses one account per worker, `hostRoom` tolerates a join prompt that
vanishes when a roamed profile arrives, and `createRoomDirectly` lets a test
create a room without a browser, so the default test user stays an anonymous
guest instead of every test becoming an account-holding host.

A measurement note worth keeping: an exhausted pool POISONS later runs. Two
full-suite results were drawn against a degraded stack before I noticed I was
measuring the environment rather than the change. Restart Supabase before
trusting a suite result that follows a failing one.

Remaining design notes:

- Hydrate via one RPC returning the whole `RoomState`, parsed by
  `roomStateSchema` — one round trip, one consistent snapshot.
- Broadcast-from-Database (`realtime.broadcast_changes()`), never Postgres
  Changes (AR-BACKEND-3's standing guardrail).
- Three rules the remote-apply path must hold: drop any broadcast with
  `version <= local`; re-hydrate on a version GAP (Realtime is at-most-once);
  and merge Yjs docs rather than replacing them, or you discard whatever this
  client typed since the sender's write.
- Realtime caps messages around 256 KB. Drawings, not notes, are the risk —
  measured: a 500-char note is 0.5 KB. Build notify-and-fetch from the start.
- `commit_mutation` as a plpgsql CAS on `rooms.version`, bounded retries, so the
  concurrent-drag race resolves deterministically.

**Also outstanding**: admission (UX-ID-3/AR-CTRL-5) was deferred by agreement;
the schema carries `status` and `hello` so it is a behaviour change, not a
migration. Avatar name/emoji still live in localStorage, so UX-ID-6/UX-ID-9 are
PARTIAL — the id roams, the avatar does not.

## Running it

```
supabase start && supabase db reset      # migrations + the pgTAP helper seed
supabase status -o env                   # copy the keys into .env
pnpm test:unit -- --run                  # offline, no Docker needed
pnpm test:rls                            # 39 pgTAP assertions
pnpm test:integration                    # real JWTs against the local stack
pnpm test:e2e                            # needs the stack (auth is real now)
```

CI runs all four: `verify` stays fast and offline, `database` starts Supabase.
`deploy` needs both, so a red RLS suite cannot ship.
