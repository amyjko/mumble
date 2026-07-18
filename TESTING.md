# Testing mumble

How the requirements in [DESIGN.md](DESIGN.md) §22 (AR-TEST-1..10) are actually carried out. This document holds the volatile part — versions, config, commands, and the reasoning behind each rule — so that DESIGN.md can hold the stable claims. Expect this file to churn; that is its job.

Every version and external claim here was verified against primary sources on **2026-07-16**. See [Versions](#versions) for the re-verification protocol.

---

## 1. The principle: local is the only pre-production environment

There is no staging, deliberately, to control cost. That decision is sound, but it has one consequence worth internalizing: **the local Supabase stack is not a convenience, it is the environment we ship through.** Everything gets one rehearsal, and this is it.

Two things follow.

**Local fidelity is load-bearing.** It's worth paying for real browsers over jsdom, real JWTs over simulated ones, and a real two-peer connection over a mocked one, because there's no later environment to catch the difference.

**The blind spots must be named.** A test suite that is silent about what it doesn't cover reads as confidence it hasn't earned. §8 is that list, and AR-TEST-10 exists to keep it honest.

---

## 2. Local development

```bash
supabase start     # first run pulls Docker images (needs network, once)
supabase stop
supabase db reset  # re-run migrations + seed
```

| Service | Port |
| --- | --- |
| API gateway (Kong) → REST, Auth, Realtime, Storage | 54321 |
| PostgreSQL **17.6** | 54322 |
| Studio | 54323 |
| Mailpit (SMTP catcher) | 54324 |

### Offline

Works with no network after the first image pull — but **only on CLI ≥ 2.108.0**. Before that release (2026-06-25) the edge runtime fetched `https://deno.land/std/http/status.ts` on every single start, so `supabase start` failed offline even with every image cached. The fix bundles the runtime with the CLI ([cli#5678](https://github.com/supabase/cli/pull/5678), [supabase#45570](https://github.com/supabase/supabase/issues/45570)).

**Tested 2026-07-16 on CLI 2.109.0 — the CLI does not block on network.** The open worry was the CLI polling `public.ecr.aws` for image freshness ([cli#1635](https://github.com/supabase/cli/issues/1635), closed as stale rather than fixed). With every image cached and the CLI's own HTTP black-holed to a dead port:

```
$ env HTTPS_PROXY=http://127.0.0.1:1 HTTP_PROXY=http://127.0.0.1:1 supabase start
exit code: 0  |  elapsed: 28s  |  12 containers up
```

Postgres, PostgREST (`/rest/v1` → 200), Auth (`/auth/v1/health` → 200) and Mailpit (`/api/v1/messages` → 200) all healthy in that state. So the ECR poll either no longer happens or fails gracefully — it does not hang startup.

> **What this does and doesn't prove.** The proxy blocks the *CLI's* outbound HTTP; the Docker daemon and the containers were not isolated, so it emulates "images cached, CLI can't phone home" — the steady-state offline case, and the one the issue was about. It is **not** full airplane mode: whether the containers themselves want network is untested. The remaining check is one minute of your time — disable networking, `supabase start` — and worth doing before anyone books a flight on this promise. One loose end: the run still printed a "new version available" notice, which was either cached from an earlier run or reaches the network by a path the proxy misses. Harmless either way, but it means "the CLI makes zero network calls" is not proven; only that none of them block.

**`wrangler dev` is part of this promise too — and now verified.** AR-DEPLOY-4 runs E2E and CI against the built worker in workerd, so AR-TEST-2's offline guarantee has to cover `wrangler dev` as well as the Supabase stack — otherwise "offline" means "offline except for the thing that tests production." Confirmed 2026-07-17 with the network genuinely down; details below.

**Verified with the network actually down (2026-07-17).** `pnpm run preview` (i.e. `wrangler dev` in workerd) was run with Wi-Fi off and served a full server-side-rendered page — real SSR markup, not a cached shell — at `GET /`. This was the one part the proxy trick couldn't reach: wrangler is Node, and Node's `fetch`/undici **ignores `HTTP_PROXY` by default** (unlike the Go-based Supabase CLI, where the proxy does bind), so an earlier proxy attempt was vacuous. A genuine network-off run settles it: **workerd starts and serves offline once the worker is built.** AR-TEST-2 holds for the runtime layer.

> **One combination still not exercised end-to-end:** `supabase start` *and* `wrangler dev` running offline *simultaneously*, with `POST /api/token` returning `"db":"reachable"`. Each half is independently verified — the CLI doesn't block on network (proxy test, 2026-07-16) and workerd serves offline (this run) — and the DB path is pure loopback, so there's no plausible failure mode left. Not worth a special trip; fold it into the first real offline dev session and record the `/api/token` body here if you think of it.

**Reproducing it** (the environment is already set up):

```bash
nvm use                      # Node 24, per .nvmrc
pnpm run build               # ONLINE first — the build fetches; it is not what's under test
# --- disable networking (Wi-Fi off / unplug) ---
supabase start                                                    # comes up on loopback
pnpm run preview                                                  # workerd on :4173
curl -s localhost:4173/ -o /dev/null -w '%{http_code}\n'          # 200 (SSR page) ✓ verified offline
curl -s -XPOST localhost:4173/api/token | head -c 120             # JSON 200; note db reachable/unreachable
```

### config.toml

All confirmed against a real `supabase init` on CLI 2.109.0, 2026-07-16:

```toml
[auth]
enable_anonymous_sign_ins = true   # exact key, confirmed. Default IS false — guests
                                   # break silently without this.
jwt_expiry = 3600

[auth.rate_limit]
anonymous_users = ...              # A test loop creating guests WILL trip this.
                                   # Symptom: tests that pass alone and fail in a suite.

[local_smtp]                       # Confirmed: this is what CLI 2.109.0 generates.
                                   # Renamed from [inbucket]; the old name still works
                                   # but warns. The official config docs page still
                                   # says "inbucket" — the docs lag the CLI.
```

`supabase status` emits **both** key styles: `PUBLISHABLE_KEY` / `SECRET_KEY` (`sb_publishable_…`, `sb_secret_…`) and the legacy `SERVICE_ROLE_KEY` JWT. Use the new pair (AR-DEPLOY-6) — the legacy names are there for compatibility, not for us. It also prints `MAILPIT_URL` and a back-compat `INBUCKET_URL`, both pointing at **54324**.

There is `auth.sms.test_otp` but **no email equivalent** — you cannot bypass magic-link delivery with a static test OTP. That absence is why §6 uses server-side link generation.

### Seeding

`supabase/seed.sql` runs after migrations on `start` and `db reset`. For multiple files:

```toml
[db.seed]
enabled = true
sql_paths = ['./seeds/*.sql']   # globs, lexicographic order
```

(Snaplet Seed appears in Supabase's docs, but Snaplet wound down in 2024 and the docs themselves describe it as community-maintained with occasional fixes. Skip it.)

---

## 3. The layers

The split *is* the strategy: each layer proves something the others structurally cannot.

| Layer | Tool | Runs in | Proves |
| --- | --- | --- | --- |
| Pure + rune logic | Vitest, server project | node | coordinate math, capacity rules, FIFO queue |
| Server units | Vitest, server project | node | load functions, form actions, `hooks.server.ts`, permission checks |
| Component | Vitest browser mode + `vitest-browser-svelte` | real Chromium | **real layout** — drag, overlap, transforms |
| RLS matrix | pgTAP via `supabase test db` | Postgres | permission × role × creator × anon; rolls back per test |
| Claim reality | Vitest + supabase-js | local stack | Auth really emits `is_anonymous` |
| Auth flows | Vitest + supabase-js | local stack | anonymous, magic link, SSR cookie session |
| E2E | Playwright → `wrangler dev` | real Chromium + **workerd** | canvas, sync, two-peer WebRTC — and the only exercise of the production runtime |
| Design conformance | contrast + no-raw-color specs (node); axe + keyboard journey (E2E) | node + workerd | the design system's WCAG 2.2 AA claims — see [STYLE.md](STYLE.md) §8 |

**E2E targets `wrangler dev`, not `vite dev`.** SvelteKit's dev server runs on Node while production runs workerd, and no plugin closes that gap ([STACK.md](STACK.md) §5). So the E2E layer carries a second job beyond browser behavior: it is where the production runtime gets tested at all (AR-DEPLOY-4). Pointing it at `vite dev` because that's faster would silently void that.

Read the last column as a set of non-overlapping claims. The pgTAP matrix cannot tell you the token really contains `is_anonymous`; the claim-reality test cannot tell you the policy matrix is right; neither can tell you a drag lands where the math says. Redundancy between layers is waste, but a gap between them is a bug nobody will find.

---

## 4. Setup

```bash
npx sv add vitest playwright
```

Take the scaffold. It already encodes the current answer: `test.projects` (not the removed `workspace`), browser mode with the Playwright provider, and no jsdom anywhere. Then bump `vitest-browser-svelte` — the scaffold pins a range that won't reach the current major (see [Versions](#versions)).

The generated config's shape, and why each part matters:

```ts
// vite.config.ts
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    projects: [
      {
        extends: './vite.config.ts',        // keeps the svelte plugin in scope — don't drop
        test: {
          name: 'client',
          browser: {
            enabled: true,
            provider: playwright(),          // a function call, not the string 'playwright'
            instances: [{ browser: 'chromium', headless: true }]
          },
          include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
          exclude: ['src/lib/server/**']
        }
      },
      {
        extends: './vite.config.ts',
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/**/*.{test,spec}.{js,ts}'],
          exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
        }
      }
    ]
  }
});
```

**The filename is the router.** `*.svelte.test.ts` → browser project; `*.test.ts` → node project. The same `.svelte` infix is also what makes the Svelte plugin compile runes in the file, so the two facts are linked: **a file that needs runes is a file that runs in the browser project**, under the default config.

That coupling has a cost. Pure rune logic (coordinate math, the capacity rules) needs runes but not a DOM, yet the default config forces it into the slower browser project. If that gets painful, add a third project with `environment: 'node'` and `include: ['src/**/*.svelte.{test,spec}.{js,ts}']` — `$state`/`$derived`/`$effect.root` don't need a DOM. This pattern is an inference from the config semantics, not something the CLI or docs endorse; validate before relying on it.

---

## 5. Testing runes and pure logic (AR-TEST-4)

Filename must contain `.svelte`. `$effect` must be wrapped in `$effect.root()`, which returns a cleanup function you must call. Effects run on a microtask — `flushSync()` to force them:

```ts
// world-coords.svelte.test.ts
import { flushSync } from 'svelte';

test('screen→world survives a scaled world layer', () => {
  const cleanup = $effect.root(() => {
    const view = new Viewport({ scale: 2, x: 100, y: 50 });
    flushSync();
    expect(view.toWorld({ x: 300, y: 150 })).toEqual({ x: 100, y: 50 });
  });
  cleanup();   // required — leaks otherwise
});
```

AR-TEST-4 makes this a constraint on the source, not just the tests: the legal-position solver (AR-CANVAS-5), screen↔world conversion, hit-testing, and the capacity/queue rules (AR-MEDIA-1, AR-CTRL-2) all have to be extractable from the components that render them. If a rule can only be tested by rendering, it's in the wrong place.

---

## 6. Component tests (AR-TEST-3)

```ts
// object-drag.svelte.test.ts
import { page } from 'vitest/browser';           // NOT '@vitest/browser/context'
import { render } from 'vitest-browser-svelte';

render(CanvasObject, { transform: { x: 100, y: 100, width: 50, height: 50 } });
await expect.element(page.getByRole('img')).toBeVisible();
```

### Why not jsdom

Not preference. From jsdom's own README, under *Unimplemented parts of the web platform*:

> **Layout**: the ability to calculate where elements will be visually laid out as a result of CSS, which impacts methods like `getBoundingClientRects()`… Currently jsdom has dummy behaviors for some aspects of these features, such as **returning zeros for many layout-related properties**.

AR-CANVAS-1 puts every object on a CSS-transformed world layer. Under jsdom, every drag delta, hit-test, resize handle, and screen↔world conversion would be computed against zeros. You can patch around it (`Object.defineProperty` on `getBoundingClientRect`), but then you're asserting your own mock — and the coordinate math the mock erases is exactly the code most likely to be wrong. Negative value: the tests would pass, look thorough, and cover nothing.

### A correction worth not repeating

A common blog claim says `@testing-library/svelte` is abandoned or broken under Svelte 5 runes. **That is false.** As of 2026-07-16 it's on v5.4.2 (2026-06-23), ~570k weekly downloads — roughly 2.5× `vitest-browser-svelte` — with one open issue and recent commits doing substantive runes work (`fix(core): separate runes and non-runes wrapper scaffold`, `fix(core): fix props proxy target to avoid double $effect runs`).

We are choosing `vitest-browser-svelte` **because we need real layout**, not because the alternative is dead. Worth being precise about internally: the reason generalizes (any real-browser runner would do), while "it's deprecated" is both wrong and would mislead the next decision.

Note also that Svelte's own [testing docs](https://svelte.dev/docs/svelte/testing) still document `@testing-library/svelte` + jsdom and never mention `vitest-browser-svelte`, while `npx sv add vitest` scaffolds the opposite. The CLI is the newer artifact and reflects the team's current default. Don't be thrown by the contradiction — and don't cite the docs page as an argument.

### The open risk — RESOLVED: the drag spike passed (2026-07-17)

The question was whether browser-mode `userEvent` could drive a pointer-capture drag; no primary source documented it. The spike ([ObjectFrame.svelte.spec.ts](src/lib/canvas/ObjectFrame.svelte.spec.ts)) settles it: **`userEvent.dragAndDrop` is provider-backed (Playwright CDP), so its input is trusted — the pointerId is real, `setPointerCapture` works, and our `pointerdown/move/up` handlers fire with real coordinates.** The suite proves a free drag commits, a constrained drag clamps at content contact (the solver ran with real geometry), and `getBoundingClientRect` returns real layout. Drag coverage stays in browser mode; AR-TEST-3's split stands.

Two findings for future drag tests:

- **Grab position matters.** `dragAndDrop` targets the element center by default — which on a note is the textarea, and `[data-editable]` correctly refuses to start a drag there (that's the product's drag-by-the-sticker-edge UX, not a bug). Pass `sourcePosition: { x: 5, y: 5 }` to grab the border ring.
- **Static-prop harnesses don't re-render from store state** — in the app, WorldCanvas re-derives props from `store.state`; a spike that passes an object literal keeps the stale prop after commit. Assert on store state and overlay cleanup, and leave DOM-position-after-commit assertions to tests that render the full canvas.

---

## 7. RLS tests (AR-TEST-5, AR-TEST-6)

```bash
supabase test db          # runs pg_prove over supabase/tests/**
supabase test new objects_rls.test
```

Each test file runs in its own transaction and is rolled back individually. That isolation is what makes the combinatorial matrix cheap, and it's the main reason pgTAP earns its place alongside the JS suites.

### The helper is ours

We do **not** use `basejump/supabase-test-helpers`, despite [Supabase's Advanced pgTAP docs](https://supabase.com/docs/guides/local-development/testing/pgtap-extended) recommending it (pinned at 0.0.6). Two reasons:

1. **Dormant.** Last substantive commit December 2023; last commit of any kind April 2024. Not archived, but not maintained.
2. **It cannot do what we need.** Its `authenticate_as` builds a fixed claim set (sub/email/phone/user_metadata/app_metadata) with no extension point. `is_anonymous` appears nowhere in v0.0.6 — and `is_anonymous` is the claim AR-AUTH-2's entire permission model turns on. Given the repo's state, this won't be fixed upstream.

So: a small vendored helper, ~30 lines, in the first alphabetical test file.

### The two rules the helper enforces

**Set the full claims blob, never `request.jwt.claim.sub`.** This is the subtle one, and Supabase's own example gets it wrong for our case. From the Auth migrations:

- [`auth.uid()`](https://github.com/supabase/auth/blob/master/migrations/20211202183645_update_auth_uid.up.sql) reads `coalesce(request.jwt.claim.sub, request.jwt.claims ->> 'sub')` — **either** source.
- [`auth.jwt()`](https://github.com/supabase/auth/blob/master/migrations/20220531120530_add_auth_jwt_function.up.sql) reads `coalesce(request.jwt.claim, request.jwt.claims)` — **only** the blob.

**Verified against the local stack, 2026-07-16** (Postgres 17.6, pgTAP 1.3.3):

```
=== A) OFFICIAL DOCS PATTERN: set local request.jwt.claim.sub ===
               auth_uid               | auth_jwt | is_anon
--------------------------------------+----------+---------
 11111111-1111-1111-1111-111111111111 | NULL     | NULL      ← auth.jwt() is dead

=== B) FULL request.jwt.claims JSON BLOB ===
               auth_uid               | is_anon
--------------------------------------+---------
 22222222-2222-2222-2222-222222222222 | true      ← works
```

The documented pattern makes `auth.uid()` work while `auth.jwt()` returns NULL. A policy reading `auth.jwt()->>'is_anonymous'` then evaluates against NULL and the test passes for the wrong reason — the worst kind of green. This is not a theoretical concern; it is the output above.

**Set `role`, and assert it.** pgTAP runs as `postgres`, which bypasses RLS ([PG docs](https://www.postgresql.org/docs/current/ddl-rowsecurity.html): superusers and `BYPASSRLS` roles "always bypass the row security system"). A test that forgets `set local role authenticated` passes while testing nothing at all.

```sql
-- authenticate as a given identity, with control over is_anonymous
create or replace function tests.auth_as(uid uuid, anon boolean default false)
returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object(
    'sub',          uid::text,
    'role',         'authenticated',
    'is_anonymous', anon
  )::text, true);
end $$;

-- every RLS test asserts its own footing first
select is(current_setting('role'), 'authenticated', 'not running as postgres');
```

### Anonymous ≠ `anon`

The trap that would quietly void every anonymous test: **Supabase anonymous users get the `authenticated` role, not `anon`.** `anon` is an *unauthenticated request*; an anonymous user is authenticated, just with `is_anonymous: true`. They are unrelated concepts that share a word. Any helper that "signs out" by setting role `anon` is not simulating a guest.

### Writing the policies

- Use `is false`, not `= false` — NULL-safe, and a missing claim *is* NULL.
- Restrictive policies only apply to roles named in their `TO` clause.
- At least one **permissive** policy must grant access before a restrictive one can narrow it. [PG docs](https://www.postgresql.org/docs/current/sql-createpolicy.html): "If only restrictive policies exist, then no records will be accessible."
- Permissive policies OR together; restrictive policies AND. This is AR-AUTH-2's footgun.

### The footgun, reproduced (2026-07-16)

Not a warning — a measurement. A `news` table with a permissive `ins_all … with check (true)`, plus an anon-blocking policy written two ways. **The predicate is character-for-character identical; only the declaration differs:**

```sql
-- THE BUG
create policy no_anon_ins on news for insert to authenticated
  with check ((auth.jwt()->>'is_anonymous')::boolean is false);

-- THE FIX
create policy no_anon_ins on news as restrictive for insert to authenticated
  with check ((auth.jwt()->>'is_anonymous')::boolean is false);
```

| Declaration | anonymous user | permanent user |
| --- | --- | --- |
| permissive (`for insert`) | **INSERT ALLOWED** ✗ | INSERT ALLOWED ✓ |
| `as restrictive for insert` | **blocked by RLS** ✓ | INSERT ALLOWED ✓ |

The permissive version allows anonymous writes **while looking completely correct** — the policy exists, reads right, is named `no_anon_ins`, and does nothing, because `ins_all` ORs with it. Two things follow, and they're the reason AR-TEST-5 and AR-TEST-6 are worded as they are:

1. **pgTAP's `policies_are()` would pass on both.** The policy exists either way. Only a behavioral test — attempt the write, observe the outcome — sees any difference. Metadata assertions are worse than useless here; they'd give false confidence.
2. **§10's mutation test is proven to work.** The two rows above *are* that test: flip `restrictive` → permissive, and a behavioral suite goes red. That's now demonstrated rather than hoped.

### A third trap: RLS sits on top of GRANTs

Found while building the above. A table created by migration has **no grants for `authenticated`** until you issue them, and a missing GRANT raises `insufficient_privilege` — **the same error class as an RLS denial.** So a test asserting "the anonymous user was blocked" can pass because the role never had table access at all, with RLS never consulted. Same shape as the `set local role` trap: green for a reason you didn't test.

Assert the positive case alongside every negative one. "Anonymous is blocked **and** permanent is allowed" is falsifiable; "anonymous is blocked" alone is satisfied by a table nobody can touch.

---

## 8. Auth flow tests (AR-TEST-7, AR-TEST-8)

**Anonymous** — works fully offline; just watch `auth.rate_limit.anonymous_users` in loops.

**Magic link** — generate server-side, skip email entirely:

```ts
const { data } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
await client.auth.verifyOtp({ token_hash: data.properties.hashed_token, type: 'magiclink' });
```

Known sharp edge: repeated `generateLink()` calls for the same user can return the same OTP ([auth#1357](https://github.com/supabase/auth/issues/1357)), which breaks after first consumption. Use a fresh email per test.

**The email template path** gets exactly one test, through Mailpit's HTTP API:

```
GET    /api/v1/search?query=to:user@example.com   → message ID
GET    /api/v1/message/{ID}                       → .Text / .HTML, regex the link
DELETE /api/v1/messages                           → purge between tests
```

**Claim reality (AR-TEST-7)** — the one test that keeps the pgTAP matrix honest:

```ts
const { data } = await client.auth.signInAnonymously();
const claims = decodeJwt(data.session.access_token);
expect(claims.is_anonymous).toBe(true);   // if this fails, the whole RLS matrix is built on sand
```

**OAuth is not tested locally.** There is no mock/stub OAuth provider in the Supabase CLI — I looked; it doesn't exist. Google/GitHub hit real network endpoints, so a local OAuth test is impossible offline. Instead: unit-test the callback handler directly, and admin-mint OAuth-identity users so downstream code sees a realistic session. The provider handshake is a prod-only truth (§9).

> Considered and rejected for now: GoTrue's Keycloak provider derives its endpoints from a configurable `url`, so a local Keycloak or Dex container could in principle give a fully offline OAuth flow. This is an inference from GoTrue's source, not a documented technique, and no write-up of anyone doing it turned up. Revisit if OAuth regressions become real; budget a spike, don't assume it works.

---

## 9. What local cannot prove (AR-TEST-10)

The honest boundary of everything above. Each of these is already an Open item in DESIGN.md — listing them here reclassifies them from *unfinished* to *untested*, which is a different kind of risk and needs a different response.

| Truth | Why local can't reach it | First measurement | Owner |
| --- | --- | --- | --- |
| NAT traversal, TURN relay fraction | Two local contexts connect over loopback and never leave the machine. The ~10–15% relay figure is assumed, not measured — and it's the MVP's only media spend (AR-COST-9, AR-TRANSPORT-8, UX-QOS-6) | first week of real connections | _unassigned_ |
| Intercontinental Broadcast latency | Realtime is region-pinned; localhost RTT is ~0 and tells you nothing (AR-BACKEND-7, UX-QOS-2) | first week, from target regions | _unassigned_ |
| Realtime quota / message-counting semantics | Whether a broadcast to N subscribers bills as 1 or N is unverified, and local has no quota (AR-BACKEND-5) | first week under real load | _unassigned_ |
| Real OAuth handshakes | No mock provider exists; real providers need network (AR-TEST-8) | manual smoke per release | _unassigned_ |
| Real egress cost | No SFU at MVP, so nothing generates egress (AR-COST-1, V2) | V2, first invoice (AR-COST-7) | _unassigned_ |

Two-peer E2E (AR-TEST-9) deserves a specific caveat, because it's the one most likely to be over-read: fake media devices fake *capture*, not the *network*. It validates signaling, negotiation, and wiring. It says nothing about connectivity — and connectivity is where WebRTC actually breaks.

**Resolved, and worth recording as a near-miss.** This section previously carried a conditional: *if* the dev server couldn't run in workerd, runtime behavior itself would join the untested list. It can't — verified 2026-07-16, `@cloudflare/vite-plugin` supports TanStack Start and React Router only, and SvelteKit's `vite dev` runs on Node ([STACK.md](STACK.md) §5). The reason that isn't fatal is that E2E was already going to drive a real server, so pointing it at `wrangler dev` costs nothing and puts the production runtime under test. Had we let E2E default to `vite dev`, **every claim in this document would have been about a runtime we don't ship** — and nothing would have said so. The inner-loop parity gap is real but bounded: a workerd-only bug is caught by CI rather than by the developer who wrote it.

**Owners are unassigned on purpose.** Fill them in before MVP close (build-order step 6); an unowned tripwire is decoration.

---

## 10. Verifying the tests themselves

A test suite is a claim about the system, and claims need checking. Run these when the harness lands:

1. **Offline really works** — `supabase start`, `stop`, disable networking, `start`. Resolves the ECR-poll uncertainty in §2. Record the answer there.
2. **Mutation-test the RLS suite** — flip one policy from `restrictive` to permissive and confirm pgTAP goes **red**. If it stays green, the suite is decorative and AR-TEST-5 is unmet. **This is the highest-value check in this document**: AR-AUTH-2's footgun is invisible to code review and invisible to passing tests — the only way to know the suite can see it is to show it failing.
3. **The role guard bites** — comment out `set local role authenticated` in one test; confirm the `current_setting('role')` assertion catches it rather than passing as `postgres`.
4. **The claim is real** — AR-TEST-7 asserts a genuine `signInAnonymously()` token contains `is_anonymous: true`. If it doesn't, every pgTAP RLS test is built on a false premise and green means nothing.
5. **Drag spike in browser mode** — ✅ passed 2026-07-17; findings recorded in §6.
6. **pgTAP version** — `select extversion from pg_extension where extname = 'pgtap';` The docs never state what the image ships. Record it in §11.
7. **Two-peer E2E connects** — two contexts, both video elements live. Then re-read §9 and remember what it didn't prove.

---

## 11. Versions

Verified **2026-07-16**. Re-verify this table before trusting it — the offline floor and the scaffold's stale pin are the two that bite.

Test-stack versions live here; runtime, package manager, TypeScript, and hosting versions live in [STACK.md](STACK.md) §2. One fact, one home.

| Package | Version | Note |
| --- | --- | --- |
| supabase CLI | 2.109.1 (this machine: **2.109.0** ✓) | **floor 2.108.0** — below this, offline is broken |
| vitest | 4.1.10 | 5.x is beta — don't |
| vitest-browser-svelte | 3.0.0 | **`sv` pins `^2.1.1`, which will not resolve to 3.0.0.** Bump deliberately; v3 changelog unverified |
| @vitest/browser-playwright | ^4.1.8 | replaces `@vitest/browser`, which no longer exists |
| playwright | 1.61.1 | |
| @supabase/ssr | 0.12.3 | still 0.x, no v1.0. Verified running under workerd with `nodejs_als` alone — [STACK.md](STACK.md) §7 |
| @supabase/supabase-js | 2.110.7 | a `3.0.0-next` exists — don't |
| @sveltejs/kit | 2.69.3 | 3.0 is on `next` |
| pgTAP | **1.3.3** (in image) | Verified 2026-07-16. Upstream is 1.3.4 — the image lags one patch |

### Gotchas

Each of these produces a test that lies, or a guide that misleads:

- `request.jwt.claim.sub` → `auth.jwt()` is NULL → `is_anonymous` policies pass wrongly. Use the blob.
- Missing `set local role authenticated` → runs as `postgres` → bypasses RLS → passes vacuously.
- `anon` role ≠ a Supabase anonymous user (who is `authenticated`).
- `is false`, not `= false`, on claims.
- jsdom returns zeros for layout — the reason AR-TEST-3 exists.
- **Vitest 4 broke three things at once**: `workspace` → `projects` (renamed in 3.2, removed in 4); provider is a function call, not a string; imports move from `@vitest/browser/context` → `vitest/browser`. Any Vitest guide written before ~2025 is wrong on all three.
- Use `$app/state`, never `$app/stores` — removed in Kit 3 (currently `next`). Free to comply with now on a greenfield project; painful later.
- Prefer `getClaims()` over `getUser()` in `hooks.server.ts` — verifies the JWT locally via JWKS instead of a network round-trip per request. "Always use `getUser()`" is 2024/2025-era advice.
- Publishable/secret keys (`sb_publishable_…`, `sb_secret_…`) replace anon/service_role and are **not JWTs** — send on the `apikey` header, never `Authorization: Bearer`. With no staging, keep local and prod on the same key style.
- WebKit has no fake media devices ([playwright#5444](https://github.com/microsoft/playwright/issues/5444), open) — Chromium only for media E2E.

---

## 12. CI

```yaml
- pnpm install --frozen-lockfile
- pnpm lint                # eslint strict-type-checked — the norms gate (STACK.md §4)
- pnpm check:ts            # TypeScript 7 (STACK.md §4)
- pnpm check:svelte        # svelte-check on the TS6 path until 7.1; a11y warnings are FAILURES
- supabase start           # pin the CLI version explicitly — the floor matters
- supabase test db         # pgTAP: RLS matrix
- vitest --run             # both projects: node + browser
- playwright test          # E2E incl. two-peer WebRTC + axe scans in both themes
- check bundle + CPU       # AR-DEPLOY-3 thresholds: 3 MB compressed, 10 ms SSR CPU
# → on main, and only if all of the above are green: deploy to production
# → on PRs: preview deployment
```

Ordered cheapest-first so the fastest signal fails first. Pin the CLI version in CI rather than taking latest: the 2.108.0 floor is the kind of thing that regresses silently on a runner image update.

**Implemented 2026-07-18** as [.github/workflows/ci.yml](.github/workflows/ci.yml).
Two deliberate differences from the sketch above: the Supabase steps are
commented out with a pointer to AR-TEST-5/6/7, because `supabase/migrations/`
does not exist yet and `supabase test db` would assert nothing; and the deploy
job is scaffolded but inert until `CLOUDFLARE_API_TOKEN` is set as a repository
secret, so CI gates today without blocking on account setup. The bundle check
is `pnpm run check:bundle` ([scripts/check-bundle.mjs](scripts/check-bundle.mjs)),
which parses `wrangler deploy --dry-run` and fails over a 600 KiB budget —
comfortably under the 3 MB cap, because a check that fails on every ordinary
change gets disabled, and a disabled check protects nothing.

**CI is the deploy gate** (AR-DEPLOY-2). With no staging, a red suite blocking `main` is the only thing between a bad commit and users — which is also why the AR-DEPLOY-3 budget checks belong here rather than in a dashboard nobody reads: a bundle that quietly grows past 3 MB stops being deployable at all.
