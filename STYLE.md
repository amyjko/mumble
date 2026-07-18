# mumble's design system

How [DESIGN.md](DESIGN.md) §12 (UX-A11Y) and §22 (AR-STYLE) are carried out. Sibling to [TESTING.md](TESTING.md) and [STACK.md](STACK.md), same division of labor: DESIGN.md holds the commitments, this file holds the mechanics — tokens, ratios, conventions, and the checklist every new component answers.

Conformance target: **WCAG 2.2 Level AA.** Enforcement is mechanical wherever automation can judge (see [Enforcement](#enforcement)); everything else is this document's checklist, applied at review.

---

## 1. Principles

- **One source of truth.** Every color, size, space, radius, and shadow comes from a token in [src/app.css](src/app.css). Raw color literals in components fail the build (`no-raw-color.spec.ts`). If a component needs a value that doesn't exist, the token is added — with its contrast pair — not inlined.
- **Contrast is computed, never eyeballed.** The table below is generated from the token file by the same math the CI spec runs.
- **The sticker aesthetic is the product.** Notes are sticky-yellow and sticker borders are white in *both* themes (UX-OBJ-8) — the dark theme darkens the room, not the paper. Anything drawn on paper-colored surfaces uses the paper's own text tokens (`--note-text`, `--sticker-text`), which are theme-invariant too.
- **Modes are visible, states aren't hidden.** Auto-fit shows on/off; zoom shows a percentage; the theme control names its current mode. If the user can be in a mode, the user can see the mode (UX-A11Y-4).

## 2. Tokens

Defined once in `src/app.css` using `light-dark()` — each color token carries both themes in a single declaration; `color-scheme` (flipped by `data-theme`) selects. **Keep one color token per line** — the contrast spec parses the file.

### Color pairs and their computed ratios (CI-enforced)

| Pair | Min | Light | Dark |
| --- | --- | --- | --- |
| `--text` on `--surface` | 4.5:1 | 16.6:1 | 14.2:1 |
| `--text` on `--surface-2` | 4.5:1 | 15.4:1 | 15.3:1 |
| `--text` on `--bg-canvas` | 4.5:1 | 14.9:1 | 16.3:1 |
| `--text-muted` on `--surface` | 4.5:1 | 7.6:1 | 6.5:1 |
| `--text-muted` on `--surface-2` | 4.5:1 | 7.1:1 | 7.0:1 |
| `--accent` on `--surface` | 4.5:1 | 6.7:1 | 8.0:1 |
| `--accent-contrast` on `--accent` | 4.5:1 | 6.7:1 | 9.2:1 |
| `--danger` on `--surface` | 4.5:1 | 6.5:1 | 5.9:1 |
| `--note-text` on `--note` | 4.5:1 | 14.4:1 | 14.4:1 |
| `--sticker-text` on `--sticker` | 4.5:1 | 7.6:1 | 7.6:1 |
| `--border-strong` on `--surface` | 3:1 | 3.7:1 | 3.8:1 |
| `--focus-ring` on `--surface` | 3:1 | 6.7:1 | 8.0:1 |
| `--focus-ring` on `--bg-canvas` | 3:1 | 6.0:1 | 9.2:1 |

New text-on-surface combinations must be added to `PAIRS` in [theme-contrast.spec.ts](src/lib/theme/theme-contrast.spec.ts) — a pairing not in that table is a pairing nobody is guarding.

### Non-color scales

- **Type**: `--font-ui` / `--font-mono` / `--font-emoji`; sizes `--text-xs` (11) / `sm` (12) / `md` (14, body) / `lg` (16); `--leading: 1.45`. Emoji render in self-hosted **Noto Color Emoji (COLRv1)**, vendored from Google Fonts as static assets under [static/fonts/noto-color-emoji/](static/fonts/noto-color-emoji/) (SIL OFL). The `@font-face` src carries `tech(color-COLRv1)`: browsers that can't render COLRv1 — notably WebKit/Safari — skip the face and fall through to the system set (Apple emoji), the requested fallback, by capability rather than UA sniffing. Chunks are unicode-range split (fetch only what's shown) and, as static assets, don't count against the worker-script cap. **Trap logged:** the `@fontsource/noto-color-emoji` npm package ships the **OT-SVG** build, which Chromium renders blank — verified by screenshot. Only the COLRv1 build works cross-browser; there is no COLRv1 build on npm, hence the vendored files.
- **Space**: 4px base — `--space-1..8` (4/8/12/16/24/32). No ad-hoc pixel gaps.
- **Radii**: `--radius-sm` (6) / `md` (10) / `lg` (16) / `full`. Panels are `md`; buttons/inputs `sm`.
- **Elevation**: `--shadow-1` (floating panels, canvas objects) / `--shadow-2` (modals, future).
- **`--target-min: 24px`** — WCAG 2.2 §2.5.8. Every clickable control sets `min-height`/`min-width` from it.

## 3. Theme mechanism (AR-STYLE-2)

`data-theme` on `<html>`: absent = system, `light`/`dark` = explicit. Persisted at `localStorage['mumble:theme']`; applied **pre-paint** by the inline script in [app.html](src/app.html), so there is never a flash of the wrong theme; runtime side in [theme.ts](src/lib/theme/theme.ts) (SSR-safe — `getTheme()` must not touch `localStorage` on the server; that bug 500'd the landing page once already). The toggle is global chrome and lives in the **layout**, bottom-left, cycling system → light → dark with its current mode in its accessible name. Theme is AR-SYNC-1 class-4 state: local, never synced.

## 4. Motion policy

Motion is a courtesy, never a carrier of information. All non-essential animation dies under `prefers-reduced-motion` via the global kill-switch in app.css — no per-component opt-in to forget. Programmatic camera fits animate (240ms) so auto-zoom is legible as an *action*; user-driven pan/zoom is always 1:1, never animated.

## 5. Keyboard map (UX-A11Y-2)

| Context | Key | Action |
| --- | --- | --- |
| Canvas (focused) | Arrows | pan |
| | `+` / `-` | zoom about center |
| | `0` | re-enable auto-fit |
| Object / avatar (focused) | Arrows | move 16px, **through the overlap solver** |
| | Shift+Arrows | move 1px |
| | Enter | edit (note → textarea) |
| | Delete/Backspace | delete (if permitted) |
| Note textarea | Escape | commit + return focus to the frame (no trap) |
| Header | "+ note" button | create at viewport center (pointer-free creation) |

Keyboard movement debounces its commit (250ms after the last keypress) and rides the same optimistic/revert path as dragging — a keyboard user sees (and hears, via the live region) the same rejection behavior as a pointer user.

## 6. Screen-reader model (UX-A11Y-3)

- **Names carry content**: a note's accessible name is its text (`Note: <first 40 chars>` / `Empty note`); an avatar's is the participant's name. Chrome-only names ("Canvas object") are a defect.
- **Announcements**: one polite `aria-live` region per room page, fed by `SyncClient.announce()` — commit rejections ("Change rejected: …"), creations, deletions. The alternating-space nonce in `announce()` is deliberate: it forces re-announcement of repeated identical messages.
- **Decorative content is silenced**: avatar emoji are `aria-hidden` (the name is the information).

## 7. The per-component checklist

Every new component answers these before merge — this is the convention half of UX-A11Y-1, covering what automation can't judge:

1. **Name**: does everything interactive have an accessible name that carries *content*, not chrome?
2. **Role**: is the element's role honest (a button is a `<button>`, a region has a role)?
3. **Keyboard**: can everything the pointer does be done from the keyboard, per the map above? No traps?
4. **Focus**: is focus visible (global `:focus-visible` ring — never disable it), and does focus go somewhere sensible after destructive actions? **Canvas objects** use an always-on `:focus-within` selection ring (thickness = their sticker border), deliberately stronger than 2.4.7 requires — on a canvas, focus is selection and must never be invisible after a click.
5. **Contrast**: does every new text/surface pairing appear in the contrast table (add it to `PAIRS`)?
6. **Motion**: is any new animation non-essential and killed by reduced-motion?
7. **Targets**: is every control ≥ `--target-min`?
8. **Announce**: do outcomes invisible to a screen reader get an `announce()`?

## 8. Enforcement inventory (AR-STYLE-3)

| Guarantee | Mechanism | Runs |
| --- | --- | --- |
| Token pairs meet 4.5:1 / 3:1, both themes | [theme-contrast.spec.ts](src/lib/theme/theme-contrast.spec.ts) computes WCAG ratios from app.css | `pnpm test:unit` / CI |
| No raw colors outside app.css | [no-raw-color.spec.ts](src/lib/theme/no-raw-color.spec.ts) scans every component | `pnpm test:unit` / CI |
| Compiler a11y warnings are failures | `svelte-check --fail-on-warnings` | `pnpm check` / CI |
| Real pages violation-free, both themes | axe (`wcag2a`+`wcag2aa`+`wcag22aa`) in [e2e/a11y.e2e.ts](e2e/a11y.e2e.ts) against the built worker | `pnpm test:e2e` / CI |
| Keyboard journey works end-to-end | same E2E: create → arrow-move (solver-constrained) → edit → escape → delete | `pnpm test:e2e` / CI |
| Theme persists, applies pre-paint | same E2E | `pnpm test:e2e` / CI |

Axe covers the automatable subset of AA (roughly 30–40% of criteria); the checklist in §7 owns the rest. Neither alone is conformance.

## 9. Exemptions log

Each exemption names its WCAG basis — an exemption without one is a violation:

- **Grid dots** (`--grid-dot`): decorative, convey no information (1.4.11 exempts decoration). Kept low-contrast on purpose.
- **Sticker borders / note yellow**: decorative surface treatment; all *text* on them uses checked pairs (`--note-text`, `--sticker-text`).
- **Shadow tokens**: decorative elevation cues, duplicated by borders where meaning matters.
- **`role="group"`/`role="application"` with tabindex + key handlers** (WorldCanvas, ObjectFrame, AvatarTile): ARIA defines no role for a movable canvas object, and a widget role would illegally nest the interactive controls inside. The compiler warning is suppressed with an in-place justification; the *behavior* (names, keyboard, focus) is verified by axe and the keyboard-journey E2E, which are the guards that actually inspect the rendered result.
