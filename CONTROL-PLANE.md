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

**Phase 5b — the store swap.** `SupabaseRoomStore` implementing the existing
`RoomStore` interface, Realtime subscription, and pointing `Room.svelte` at it.
Left undone on purpose: it replaces the storage layer of a working app, and the
plan's own risk note says if it slips, Phases 1–5a still stand and the app still
runs. Design notes:

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
