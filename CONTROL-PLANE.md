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

- **E2E flakiness — cause NOT yet identified.** 1-4 of 85 fail per run with a
  rotating set. Three things were measured and each refuted a hypothesis:
  widening the 18 cross-client assertions to a 10s budget changed the rate not
  at all; raising Playwright's global `expect` timeout to the same value changed
  it not at all (so that raise was reverted rather than kept as an unsupported
  change); and the database is entirely healthy during a failing run — 20
  connections, 2 active, nothing waiting or idle-in-transaction. Worker count
  does not correlate cleanly either: 4 workers produced FEWER failures than 2,
  and a serial run is usually but not always green.

  Three genuine races were found and fixed structurally along the way (a hover
  landing on an auto-fit-animating frame, a non-atomic z-index sample, and four
  fixed `waitForTimeout` sleeps standing in for network writes). They are worth
  having on their own and are not the whole story.

  **Three hypotheses now refuted, each by measurement:**
  1. *Assertion budget.* Widening 18 cross-client assertions to 10s: no change.
     Raising Playwright's global `expect` timeout to the same: no change. The
     global raise was reverted.
  2. *Database or pool contention.* Sampled every 3s through a failing run: 20
     connections, 2 active, none waiting, none idle-in-transaction.
  3. *The concurrency model.* Per-object versions removed the room-wide false
     conflict for `edit_note` entirely — and the failure rate was 2, 4, 2 across
     three runs afterwards, statistically identical to before.

  Worker count does not correlate cleanly either (4 workers produced FEWER
  failures than 2; serial is usually but not always green). Whatever this is, it
  is not write contention, not the database, and not the budget. Worth a fresh
  look with a bisect over the spec files or a trace of one captured failure,
  rather than a fourth guess.
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
