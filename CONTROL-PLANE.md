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

**Phase 5b — the switchover.** Everything except pointing the canvas at it is
DONE and tested: `SupabaseRoomStore`, `save_room_state` (one transaction for
every table plus the version bump plus the broadcast), `get_room_state`, the CAS
with bounded retry, and the `realtime.messages` channel-join policy.

I attempted the switchover on 2026-07-19 and backed it out. It is a four-line
change plus test fallout, and the fallout is the part to plan for:

- `Room.svelte` must take an INJECTED store (it currently constructs
  `MemoryRoomStore` itself, which violates room-store.ts's own rule that no
  consumer may name a backend). The route supplies `SupabaseRoomStore`; tests
  supply the stub.
- `/hey/[room]` needs a `+page.server.ts` that 404s a room absent from Postgres.
  `ssr = false` does NOT prevent this — that flag disables server RENDERING, not
  server `load` — but `+page.ts` must forward the server data explicitly,
  because when both loads exist the universal one's return value is what the
  page receives.
- Every E2E that joins a room then needs the room to EXIST, so `joinRoom` has to
  create it, which needs an account. That is the bulk of the work: ~85 tests
  change behaviour at once, and several assert guest-only UI.
- The DevPanel is stub-only (it injects latency and forces rejections). Against
  the real backend those levers do not exist, so it should be absent rather than
  showing dead controls.

### THE blocker, found on the second attempt (2026-07-19)

`save_room_state` writes the ENTIRE room on every mutation — every object,
participant and configuration, in one plpgsql transaction — for each keystroke
and each drag commit. Each call holds a database connection for the duration.
PostgREST's pool (10 by default) saturates almost at once, and every request
after that fails with *"Timed out acquiring connection from connection pool"*,
which reads exactly like broken application code.

That is the "correctness before cleverness" choice made in Phase 5a, and it does
not survive contact with traffic. Raising the pool size would hide it locally
and reproduce it in production, where the cost is O(room) writes per keystroke.

**The switchover is blocked on incremental writes**, not on the store, the
route, the fan-out, or the tests. What it needs:

- a diff between the prior and next `RoomState` — the route already has both, so
  this is a pure function over two values, testable with no database at all;
- `save_room_state` taking that diff (changed rows and deleted ids) rather than
  the whole document, keeping the version CAS and the in-transaction broadcast;
- the same treatment for `edit_note`, which is the highest-frequency mutation
  and today rewrites every object row to append to one Yjs document.

Until then the UI stays on the stub, which works.

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
