# Overnight front-end backlog — autonomous build spec

This file is the durable spec for an unsupervised overnight run (driven by
`/goal`). Re-read it at the start of every turn — it is the source of truth even
if conversation context has been compacted. Optimize for a reviewable branch by
morning, not for finishing everything.

## STEP 0 — clean base (do this first, once)

The working tree has a finished, manually-verified batch (Noto COLRv1 emoji,
always-on focus rings, collide-and-slide solver, tab-into-view). Commit it as
its own commit on a new branch so overnight features stay separate:

    git checkout -b overnight/frontend-backlog
    git add -A && git commit -m "Emoji COLRv1, focus rings, tangent solver, tab-reveal"

All subsequent feature commits go on this same branch. Do NOT push, open a PR, or
touch main.

## SOURCE OF TRUTH (read before building)

- DESIGN.md — the requirements (each backlog item cites its UX-IDs).
- STYLE.md — design system + a11y conventions + the per-component checklist (§7).
- TESTING.md, STACK.md — how things are built and verified here; the norms (STACK.md §4).
- The RoomStore seam (src/lib/store/) — the in-memory store is the only backend.

## HARD CONSTRAINTS (violating any is a failure, not a tradeoff)

- Never weaken a gate to make it pass. `pnpm lint`, `pnpm check:ts`,
  `pnpm check:svelte` (--fail-on-warnings), `pnpm exec vitest --run`, and
  `pnpm exec playwright test` must ALL be green before every commit. If a gate
  can't pass honestly, stop and leave notes in OVERNIGHT-REPORT.md.
- No component may name a backend — everything goes through RoomStore. Do NOT
  touch the media/WebRTC plane, real auth, admission, storage, or cost. Out of
  scope tonight.
- No raw colors, no `as`, no `any`, no disabled lint rules without a written
  justification. Add tokens to app.css (with contrast pairs in
  theme-contrast.spec.ts) rather than inlining. Every new component answers
  STYLE.md §7's checklist and is keyboard-operable through the same
  solver/permission paths as existing ones.
- Do NOT check any DESIGN.md checkbox — stub-backed work isn't verified.
- New enforcement you add (e.g. a zod schema) must be mutation-tested: prove the
  test goes red on a real defect, then restore green.
- Use Node 24 via nvm (`nvm use`), pnpm 11. Confirm the worker bundle stays well
  under 3 MB (`wrangler deploy --dry-run`).

## WORKFLOW, per feature (one feature = one commit)

1. Build behind the stub, following existing patterns: NoteObject + ObjectFrame
   dispatch, the polymorphic schema / discriminated union (model/schemas.ts),
   the optimistic SyncClient, the mutation vocabulary.
2. Add tests: node specs for pure logic, browser specs for components (the
   drag/pointer pattern in ObjectFrame.svelte.spec.ts), an E2E only for a real
   user journey.
3. Run ALL gates green.
4. Update DESIGN.md prose / STYLE.md / TESTING.md if warranted, keeping
   cross-refs clean (no dangling AR/UX ids).
5. `git commit` on `overnight/frontend-backlog` with a message naming the UX-IDs
   and any judgment calls made.

## PRIORITY ORDER (in order; skip anything that turns ambiguous and note it)

1. Timer object (UX-OBJ-4) — mirrors the note pattern, exercises the schema's
   second type (proves the union isn't note-shaped). Do this first.
2. Chat object (UX-OBJ-3).
3. Settable canvas background (UX-CANVAS-5) + scale-object-to-fullscreen
   (UX-CANVAS-4) — contained, per-viewer view state.
4. Note markdown rendering (UX-OBJ-2, render only — NOT collaborative CRDT).
5. Remaining clip shapes: ellipse, polygon, path (UX-OBJ-7).
6. Resize + rotate handles (UX-OBJ-1) — reuse the solver; rotation is the hard
   part, so if rotated-shape overlap math gets deep, ship resize and leave
   rotate with notes.
7. Drawings — colored SVG paths (UX-OBJ-11).
8. Transient + persistent emotes, raise-hand, self-initiated (UX-AV-4/5/6/7)
   over the existing ephemeral channel.
9. Room + config titles/descriptions and room rename (UX-ROOM-2/10).
10. Configurations — snapshot/switch/edit-live/reset (UX-ROOM-3/4/5/6). THE
    AMBIGUOUS BIG ROCK: if the switch semantics for objects-present-in-one-
    config-not-another (an open item in DESIGN.md) aren't clearly resolvable
    from the doc, build the data model + switching but STOP before guessing the
    UX, and leave a detailed note for morning review.

Defer (only if everything above is done): host role + permission-setting UI,
join form, capacity/stage UI — these lean on concepts (hosts, media) better
landed with their real counterparts.

## AMBIGUITY POLICY

Make reasonable calls within DESIGN.md + STYLE.md and log each in the commit
message. Stop and leave notes ONLY for genuinely irreversible or scope-defining
forks (like #10). Prefer finishing 8 features cleanly over starting 20.

## END OF RUN

Write OVERNIGHT-REPORT.md at the repo root: what shipped (commit hashes +
UX-IDs), what you stopped on and why, decisions that deserve a second look, and
the recommended next step. Make its final line exactly:

    STATUS: COMPLETE

Do NOT write that line until the work is genuinely done or every remainder is
documented as blocked — it is the signal that ends the run.
