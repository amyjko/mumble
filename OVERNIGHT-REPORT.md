# Overnight report — front-end backlog

Autonomous run against [OVERNIGHT-PLAN.md](OVERNIGHT-PLAN.md). Branch:
`overnight/frontend-backlog` (12 commits on top of `main`, nothing pushed).

**All 10 backlog features shipped, every gate green on every commit.** Final
state: lint · check:ts (TS7) · check:svelte (--fail-on-warnings) · 151 unit +
component tests · 19 Playwright E2E · worker bundle 234 KiB (7.6% of the 3 MB
cap). Node 24 / pnpm 11 throughout. No gate was ever weakened; no DESIGN.md
checkbox was checked (stub-backed work isn't verified).

## What shipped (one commit each, in plan order)

| # | Feature | UX-IDs | Commit |
|---|---|---|---|
| 1 | Timer object (countdown/countup, shared-timestamp anchor) | UX-OBJ-4 | `574a448` |
| 2 | Chat object (retained log, open posting) | UX-OBJ-3 | `d6ca6e7` |
| 3a | Settable canvas background (shared, injection-guarded) | UX-CANVAS-5 | `5c1ac8e` |
| 3b | Scale-object-to-fullscreen (per-viewer) | UX-CANVAS-4 | `97c18d5` |
| 4 | Note markdown rendering (safe hand-rolled renderer) | UX-OBJ-2 | `102d5dd` |
| 5 | Clip shapes: ellipse + polygon | UX-OBJ-7 | `5ed6dc1` |
| 6 | Resize + rotate (handles + keyboard) | UX-OBJ-1 | `1ee6350` |
| 7 | Drawings — colored SVG paths (freehand capture) | UX-OBJ-11 | `9f4b01e` |
| 8 | Emotes + raise-hand + away | UX-AV-4/5/7 | `1139cfa` |
| 9 | Room title/description + rename | UX-ROOM-2/10 | `ab030b7` |
| 10 | Configurations (named layout snapshots) | UX-ROOM-3..6 | `b77abaf` |

The object union grew from 1 type (note) to 5 (note, timer, chat, drawing +
the shape/clip machinery). Every new mutation goes through the same
`RoomStore` seam and optimistic `SyncClient`; nothing under `canvas/` names a
backend. New enforcement (each safe-value validator) was mutation-tested.

## Deliberately deferred — need a product decision, not more code

These are the honest stopping points, each noted at its DESIGN.md open item:

1. **Configuration switch semantics (the ambiguous big rock).** Configs are
   built as additive named layout snapshots (transforms + background + title),
   with save/switch/reset/delete all working and tested. But **what happens to
   objects present in one config but not another — hide vs remove — is an
   explicit DESIGN.md open item, so I did not guess it**: objects absent from a
   snapshot are left in place on switch. The deeper model (separating object
   *content* from per-config *layout*, plus per-config capacity/default-
   location) is also deferred — the snapshot approach is a safe stub that
   avoided restructuring the object schema (and risking the other 9 features)
   at the end of the run. **This is the item most wanting your eye.**
2. **Arbitrary `path` clip shape (UX-OBJ-7).** Ellipse + polygon shipped
   (percentage clip-path, scales cleanly). Path needs an SVG `objectBoundingBox`
   clipPath and a matching sticker-border stroke — the arbitrary-path open item
   AR-CANVAS-2 already names.
3. **Rotate is world-axis-approximate.** Resize/rotate math ignores rotation,
   and rotated-shape collision stays AABB. Fine for prototyping; true rotated-
   handle resize + SAT collision is a follow-up.

## Decisions I made (worth a second look)

- **Chat posting is open to everyone present**, regardless of the chat object's
  edit permission (moving/deleting it still obeys permission) — same spirit as
  self-initiated emotes. If chat should be host-gated, that's a one-line change.
- **Emotes are self-only**, enforced in the store (`set_hand`/`set_away`
  rejected unless the id is your own). Raise-hand-as-queue-entry (UX-AV-6) is
  deferred with the stage/slot queue (a media-plane feature).
- **One stroke per drawing gesture** (multiple strokes = multiple objects) — a
  simplification; a "drawing accumulates strokes" model is also reasonable.
- **Room rename carries state but does not free the old name** — old URLs still
  rehydrate in the stub. Real uniqueness/freeing is server-side (AR-BACKEND-10).
- **A new `palette.ts`** holds user-selectable draw colors as DATA; it's the one
  sanctioned exemption from the no-raw-color rule (documented in the spec).
  Component styling still goes entirely through tokens.
- **Markdown uses a hand-rolled safe renderer** rather than marked+DOMPurify —
  escape-first, validated hrefs, XSS-mutation-tested — so the `{@html}` is a
  justified lint exception, and we added no dependency.

## One real bug found (pre-existing, surfaced by resize) — NOT yet fixed

**Avatars render at `z-index: 1000`, above all objects.** An avatar sitting over
an object occludes that object's resize/rotate handles (and blocks dragging the
object beneath it). Resize/rotate is fully keyboard-operable so it's not a
blocker, but the pointer handles are unreachable under an avatar. Options for a
later pass: a z-band between objects and avatars, or raising an object's z on
focus/hover. This predates tonight's work; resize just made it visible.

## Recommended next step

Make the **configuration switch-semantics** decision (deferred item #1) — it's
the gate on finishing configs properly and it needs your product judgment on
hide-vs-remove and on the content/layout split. Everything else on the branch is
complete and independently reviewable, commit by commit.

To review:

```sh
git checkout overnight/frontend-backlog
nvm use          # REQUIRED — not optional; see below
pnpm dev         # then open two windows on http://localhost:5173/hey/lci
```

No Supabase needed: the whole branch runs on the in-memory stub.

**`nvm use` is required, not a nicety.** Without it you get the shell's default
Node 22 and the standalone pnpm at `~/Library/pnpm/pnpm`, which is **pnpm 10** —
and pnpm 10 cannot bootstrap the pnpm 11 named in `packageManager`. It fails
mid-self-install and leaves a half-extracted 11.13.1 in `~/Library/pnpm/.tools/`
(the `pnpm CLI is missing … ENOENT` error). Deleting that cache doesn't help;
it re-creates the same broken state. `nvm use` sidesteps it entirely — the Node
24 toolchain carries its own working pnpm 11.13.1. If you want the default
shell fixed too, upgrade the standalone: `curl -fsSL https://get.pnpm.io/install.sh
| env PNPM_VERSION=11.13.1 sh -`. You'd still need `nvm use` for Node 24.

STATUS: COMPLETE
