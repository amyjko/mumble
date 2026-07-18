# mumble's stack

How the requirements in [DESIGN.md](DESIGN.md) §12 (AR-STACK) and §22 (AR-DEPLOY) are actually carried out. This document holds the volatile part — versions, config, and the gotchas behind each rule — so DESIGN.md can hold the stable claims. Sibling to [TESTING.md](TESTING.md), same division of labor. Expect this file to churn.

Verified against primary sources on **2026-07-16**. See [Versions](#versions) for what to re-check and when.

---

## 1. The decisions

| Decision | Choice | The one-line why |
| --- | --- | --- |
| Runtime (dev/test/build) | **Node, Active LTS** | Vitest and Playwright are committed (AR-TEST-1) and are exactly what Bun doesn't support |
| Package manager | **pnpm 11** | Supply-chain defaults, not speed |
| TypeScript | **7.0**, now | Shipped 2026-07-08; our code was already compliant |
| Host | **Cloudflare Workers** | Genuinely $0, commercial OK, consolidates four Cloudflare dependencies |
| Release | **push to main** | PRs get previews; CI gates prod |

**Both of the bets in the hosting choice were settled empirically on 2026-07-16, and they went opposite ways.**

- **The bundle is a non-issue.** A real worker carrying both Supabase libraries uploads at **234 KiB gzipped against a 3 MB cap** — 7.6%, ~13x headroom (§5). This was the blocking risk. It isn't one.
- **The dev server cannot run in workerd.** `@cloudflare/vite-plugin` supports TanStack Start and React Router only; SvelteKit's `vite dev` runs on Node (§5). AR-DEPLOY-4 was rewritten to put the parity line where it holds — **CI and E2E run in workerd, the HMR loop doesn't, and nothing is verified on the Node path.**

Cloudflare survives on the merits: the worker itself, running both Supabase libraries under workerd, served SSR and an API route at 200. What we lost is dev-time parity, which is a real cost paid for a real saving.

---

## 2. Versions

Registry-verified 2026-07-16 unless noted.

| Thing | Version | Note |
| --- | --- | --- |
| Node | **24.18.0** (Active LTS) | LTS since 2025-10-28, EOL 2028-04-30. **Bump to 26 after 2026-10-28** when it enters LTS |
| pnpm | **11.13.1** | Needs Node 22+ |
| TypeScript | **7.0.2** | GA 2026-07-08. `tsc` is now the Go binary |
| TypeScript (aliased) | **6.0.3** | Required by svelte-check — see §4 |
| svelte-check | 4.7.3 | TS6 only. `--tsgo` flags exist but are broken |
| SvelteKit | **2.69.3** | 3.0 is on `next` |
| @sveltejs/adapter-cloudflare | **7.2.9** | 8.0 is on `next`. `adapter-cloudflare-workers` is deprecated |
| wrangler | **4.111.0** | |
| Vite | **8.1.5** | |
| @cloudflare/vite-plugin | 1.45.0 | Active, but **does not support SvelteKit** — see §5 |
| Vitest / Playwright | 4.1.10 / 1.61.1 | Details in [TESTING.md](TESTING.md) |

**This machine, as of 2026-07-16:** Node **22.22.1** (Maintenance — needs upgrading to 24), pnpm **10.14.0** (needs 11), Supabase CLI **2.109.0** (above the 2.108.0 offline floor ✓), Docker 29.5.2. The Node and pnpm gaps are the first thing to fix in build-order step 0.

Node's odd/even rule holds: **odd lines never become LTS.** Node 25 is already EOL; Node 26 is Current until October. Don't build on Current.

---

## 3. Package manager (AR-STACK-4)

pnpm is chosen for **defaults, not speed**. A small team cannot audit its transitive dependency tree, so the package manager has to do that work. What pnpm 11 gives free:

```yaml
# pnpm-workspace.yaml
minimumReleaseAge: 10080          # 7 days. Default is 1440 (24h) — too short
                                  # against real detection windows
minimumReleaseAgeExclude:         # escape hatch for hotfixes
  - '@supabase/*'
```

**The migration gotcha:** pnpm 11 moved its settings **out of `.npmrc`**. That file is auth/registry only now; pnpm config lives in `pnpm-workspace.yaml` or `~/.config/pnpm/config.yaml`. Every pre-2026 pnpm guide will tell you otherwise.

Also on by default in 11: `blockExoticSubdeps`, `strictDepBuilds`. Store v11 is a single SQLite DB rather than millions of JSON files.

### What actually happened setting this up (2026-07-16)

Four things that no amount of doc-reading would have told us:

**1. pnpm 10 cannot bootstrap pnpm 11.** The `packageManager` field *is* read — pnpm 10.14 dutifully tried to fetch 11.13.1 — and then failed: `Failed to switch pnpm to v11.13.1… spawnSync …/bin/pnpm ENOENT`. It downloads `@pnpm/macos-arm64@11.13.1` but pnpm 11's package layout has no `bin/pnpm` where v10 looks. **So the `packageManager` field does not get you from 10 to 11**; install pnpm 11 directly first (`npm i -g pnpm@11` under the right Node). The field works fine *after* that, for staying pinned.

**2. `allowBuilds`, not `onlyBuiltDependencies`.** pnpm 11 renamed it, and the new form is a **map**, not a list. v10's spelling silently does nothing. pnpm helpfully auto-writes a stub for you to fill in.

**3. `strictDepBuilds` blocks workerd — which silently breaks the host.** Out of the box: `Ignored build scripts: esbuild, sharp, workerd`. **workerd is the Workers runtime**, so `pnpm preview` / `wrangler dev` cannot run at all until it's approved. The security default is right; it just isn't optional here.

**4. The cooldown is hard-enforced, and it changes your version ranges.** `minimumReleaseAge` is not a warning — an unsatisfiable range is a build error:

```
ERR_PNPM_NO_MATURE_MATCHING_VERSION
  svelte-check@4.7.3 was published at 2026-07-15…, within the minimumReleaseAge cutoff
```

That was self-inflicted: we'd *pinned* `^4.7.3`, published the day before. **With a cooldown, dependency ranges must be floors, not pins** — otherwise the two policies contradict and nothing installs. What 7 days actually costs, measured:

| | installed | latest | |
|---|---|---|---|
| wrangler | 4.110.0 | 4.111.0 | ~daily releases (173 v4 versions) |
| vite | 8.1.4 | 8.1.5 | |
| svelte-check | 4.7.2 | 4.7.3 | |
| @supabase/supabase-js | 2.110.2 | 2.110.7 | |
| vitest, typescript, ts7, vitest-browser-svelte | — | = latest | already mature |

A patch version or two behind on fast movers. That is the whole price, and it's worth paying — but note §2's table lists *latest*, which is deliberately **not** what the lockfile holds. Don't "fix" the difference.

### Pinning — and why not Corepack

**Corepack is unbundled from Node 25 onward.** Node 24 still ships it (experimental); Node 26 will not — which lands right when we bump in October. So `packageManager` + Corepack is not a strategy that survives this year.

Instead: keep the `packageManager` field in `package.json` (pnpm self-manages to it, and CI providers read it), and use `pnpm/action-setup` in CI, which reads that field without needing Corepack to exist.

### Why not npm, and why that's close now

npm v12 (2026-07-08) turned **install scripts off by default**, which was pnpm's headline safety advantage and the primary worm-propagation vector. The gap is genuinely narrow now. pnpm still wins on the cooldown being *default* rather than opt-in, and on symlinked `node_modules` making phantom dependencies fail loudly rather than silently working until CI. If pnpm's symlinks ever cost more than they're worth (§7), npm v12 with a manual `min-release-age` is a defensible retreat.

---

## 4. TypeScript (AR-STACK-2)

**TypeScript 7.0 shipped 2026-07-08.** `tsc` is the Go native binary; `npm install -D typescript` gets the fast compiler. Reported speedups: VS Code 125.7s→10.6s, Playwright 12.8s→1.47s. Memory down 6–26%.

AR-STACK-2 was written as V2 futureproofing and is now simply true. **The constraint was always on us, not on TypeScript** — plain TS, no plugins, no decorators — and we already meet it. Enforce it mechanically rather than by discipline:

```jsonc
{
  "compilerOptions": {
    "erasableSyntaxOnly": true,     // bans enums, namespaces, parameter properties
    "verbatimModuleSyntax": true    // forces `import type`
  }
}
```

### The catch: svelte-check crashes under TS7 (verified)

**TS 7.0 ships no stable programmatic API, and the announcement names Svelte explicitly** among blocked tools. This is not theoretical — tested 2026-07-16 with `svelte-check` 4.7.3:

```
$ npx tsc -v                 # TypeScript 7.0.2
$ npx svelte-check
TypeError: Cannot read properties of undefined (reading 'useCaseSensitiveFileNames')
    at new FileMap (svelte-check/dist/src/index.js:9013:72)
```

`typescript.sys` is `undefined` — the Go binary doesn't expose it. Reverting to TypeScript 6.0.3: `svelte-check found 0 errors`. So this is a hard incompatibility, not a warning.

**The `--tsgo` flags do not work.** `svelte-check` 4.7.3 does have them (this much the research got right):

```
--tsgo                     Use tsgo for TypeScript diagnostics.
--tsgo-experimental-api    ...Experimental feature, might break without warning.
```

Both **crash** — under TS7 (same `ts.sys` error) *and* under TS6 (`svelte-check failed` at `runWithVirtualFiles`). Don't reach for them; the docs' own "might break without warning" is doing real work.

### The working recipe

Install both, side by side. `typescript` must be **6** because that's what `svelte-check` imports; TS7 comes in under an alias:

```jsonc
// package.json
"devDependencies": {
  "typescript": "^6.0.3",           // svelte-check imports this
  "ts7": "npm:typescript@^7.0.2"    // tsc --noEmit runs this
}
```

`@typescript/typescript6` (v6.0.2, 2026-07-06) also exists as the official compatibility package; a plain alias is simpler and was what I verified.

**Gotcha found while testing:** the alias's `tsc` binary **clobbers** the real one — `node_modules/.bin/tsc` resolves to 7.0.2 while `require('typescript')` gives 6.0.3. That happens to be the split we want, but by accident of bin-resolution order, which isn't guaranteed. Call the binary explicitly in scripts rather than relying on it:

```jsonc
"scripts": {
  "check:ts": "ts7/bin/tsc --noEmit",   // explicit — don't trust bare `tsc`
  "check:svelte": "svelte-check --tsconfig ./tsconfig.json"
}
```

For reference, `sv create` currently scaffolds `typescript: ^6.0.3` — the scaffold has not moved to TS7 either, for exactly this reason.

### TS7 breaking changes that bite a greenfield setup

`strict: true` is now default · `types` defaults to `[]` (was `["*"]`) · `rootDir` defaults to `./` · hard errors on `es5`/`amd`/`umd`/`classic` moduleResolution.

### Norms (set 2026-07-17, enforced mechanically)

Strict typing, no `as`, no dodging; catch everything possible at compile time; extra effort at type-unsafe boundaries. Enforcement is compiler + linter, never review vigilance:

**tsconfig** (on top of `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`): `noUncheckedIndexedAccess` (indexed access is `T | undefined` — the one that bites most usefully), `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`. Note `checkJs` is deliberately **off** — see gotchas.

**ESLint** (`typescript-eslint` **strict-type-checked** + `eslint-plugin-svelte`): `consistent-type-assertions: never` bans `as` outright; `no-explicit-any` + the `no-unsafe-*` family catch `any` *leaking through* calls, not just written; `no-non-null-assertion` bans `!`; `ban-ts-comment` requires a written reason on `@ts-expect-error` and bans `ts-ignore`/`ts-nocheck` entirely. Generated files (`worker-configuration.d.ts`, `src/lib/database.types.ts`) are exempt — norms govern what we write.

**The boundary pattern**: `any` exists only at the edge and is immediately laundered to `unknown` — `const parseJson = (t: string): unknown => JSON.parse(t)` needs no assertion — then parsed with a **zod** schema (`safeParse`), never hand-narrowed. Zod schemas in `src/lib/model/schemas.ts` are the single source of truth for boundary-crossing shapes; types come from `z.infer`, so schema and type cannot drift. The same mutation schemas later validate AR-SYNC-3's server route bodies. Cross-tab messages ride a **versioned envelope** (`{ v: 1, ... }`); unknown versions are dropped silently — type safety against a stale tab running older code, which models the stale-client reality the real backend will have.

**Proven, not asserted** (2026-07-17): planting a deliberate `as`, an explicit `any`, and a bare `@ts-expect-error` turned lint red on all three (plus two `no-unsafe-*` leak catches); removal restored green. The norms also caught real things on day one: the scaffold's own untyped `$props()`, a floating promise in its demo test, `zod`'s `z.uuid()` rejecting malformed test UUIDs (RFC-4122 variant bits), and `erasableSyntaxOnly` rejecting constructor parameter properties in freshly written store code — AR-STACK-2 enforcing itself.

### A convergence worth noticing

Node v26 **removed `--experimental-transform-types`**, settling permanently on erasable-syntax-only. Node's built-in type stripping (stable since 24.12.0) is erasure only — no enums, no decorators, no namespaces, and it never typechecks. That is the same constraint AR-STACK-2 already imposed, arrived at independently. The industry moved to where the requirement already was.

---

## 5. Hosting (AR-DEPLOY)

Cloudflare Workers via `@sveltejs/adapter-cloudflare`. Note `adapter-cloudflare-workers` is **deprecated** — there is one Cloudflare adapter now.

```jsonc
// wrangler.jsonc
{
  "compatibility_date": "2026-07-15",      // must be ≤ what your workerd supports — see below
  "compatibility_flags": ["nodejs_als"]    // what `sv create` generates; verified sufficient
}
```

**The cooldown and `compatibility_date` collide — a real, non-obvious trap.** `sv create` generated `"compatibility_date": "2026-07-17"` — a **future date**. The 7-day cooldown (§3) then resolved wrangler to 4.110.0, whose bundled workerd tops out at 2026-07-15:

```
✘ service core:user: This Worker requires compatibility date "2026-07-17",
  but the newest date supported by this server binary is "2026-07-15".
✘ The Workers runtime failed to start.
```

Two of our own requirements — AR-STACK-4's cooldown and AR-DEPLOY-1's host — disagreed, and the app simply would not boot locally. **Rule: `compatibility_date` must be ≤ the newest date your *pinned* wrangler's workerd supports, not today's date.** Every wrangler bump is a chance to raise it; the cooldown means that's always slightly behind the calendar. Re-check this whenever wrangler moves.

### The limits, and which ones are real

| | Free | Paid (from $5/mo) |
| --- | --- | --- |
| Requests | 100,000/day | 10M/mo, then $0.30/M |
| **CPU per invocation** | **10 ms** | 5 min max |
| **Bundle (compressed)** | **3 MB** | 10 MB |
| Subrequests | 50/request | 1,000+ |

**CPU time is not wall time.** Waiting on `fetch`, a Postgres query, or a KV read costs nothing — only real JS execution counts. HTTP-triggered Workers have no max duration while the client stays connected. So the token endpoint's Supabase round-trip is free; the 10 ms budget is spent on SSR rendering, not on I/O.

### Measured, not assumed (2026-07-16)

A real spike settled the bundle question. SvelteKit (minimal template, `adapter-cloudflare`, `cfTarget: workers`) + `@supabase/supabase-js` 2.110.7 + `@supabase/ssr` 0.12.3, with a `hooks.server.ts` calling `createServerClient` and an API route calling `createClient(...).from().select()` — so both libraries are genuinely reachable from the worker, not tree-shaken away:

```
$ wrangler deploy --dry-run
Total Upload: 1188.83 KiB / gzip: 234.49 KiB
```

**234 KiB against a 3 MB cap — 7.6% of budget, ~13x headroom.** The bundle is not a risk. Svelte's docs warn about oversized workers and advise pushing large libraries client-side; at this scale that advice doesn't bind. AR-DEPLOY-3 stays anyway, as a ratchet: the number only matters if it's watched.

Both endpoints then served **HTTP 200 under real workerd** via `wrangler dev` — SSR through `hooks.server.ts`, and `POST /api/token` through `supabase-js`. **Notably with `nodejs_als` only, not `nodejs_compat`** (see §7).

**Still to measure: SSR CPU-ms against the 10 ms cap.** The spike didn't measure it — a hello-world page proves nothing about our real SSR. Mumble is client-heavy (the canvas isn't server-rendered) so it *should* be thin, but "should be" is not a measurement. Wire it into CI alongside the bundle check when there's a real page to measure.

If either ever fails, AR-DEPLOY-5's fallback: `adapter-node` on Fly.io, ~$2/mo (`shared-cpu-1x` 256MB ≈ $2.02/mo running), no ceilings, exact local/prod parity.

### Why not the others

- **Vercel** — Hobby is **non-commercial use only** per Vercel's fair-use terms. A product starts at Pro, **$20/seat/mo**. That fails UX-ECON-1's cost test outright. This is the single most surprising finding of the hosting research and the one most likely to be wrong in someone's memory.
- **Deno Deploy** — genuinely tempting: an official Deno-maintained SvelteKit adapter, 15 CPU-hours free (vs Vercel's 4), commercial OK, self-host escape hatch. Rejected because prod would run Deno while dev and tests run Node, and AR-TEST-10 says we have no staging to catch what that hides.
- **Netlify** — moved to a credits model and **no longer publishes concrete limits**. Free = "300 credits/month" with no stated bandwidth/function equivalents. Cannot be evaluated without a dedicated dig; the old "100GB / 125k invocations" numbers should not be assumed to still hold.
- **Render** — free tier spins down after 15 min idle with a ~1 min cold start. Fatal for a token endpoint. $7/mo for always-on.

### Local parity (AR-DEPLOY-4) — answered, and not the way I hoped

**The SvelteKit dev server cannot run in workerd.** Verified 2026-07-16:

- `@cloudflare/vite-plugin` (v1.45.0, actively maintained — published 2026-07-15) officially supports **TanStack Start and React Router v8 only**. Cloudflare's docs never mention SvelteKit, and the package README mentions React Router twice and Svelte zero times.
- The SvelteKit Cloudflare scaffold doesn't use that plugin at all. It wires `sveltekit({ adapter: adapter() })` into `vite.config.ts` and its `dev` script is plain `vite dev` — **Node**.

So the split is structural, not a configuration we got wrong:

| Command | Runtime | Use |
| --- | --- | --- |
| `vite dev` | **Node** | inner loop, HMR. **Nothing is verified here.** |
| `wrangler dev .svelte-kit/cloudflare/_worker.js` | **workerd** | the scaffold's `preview` script. Real runtime, no HMR, needs a build first |

AR-DEPLOY-4 was rewritten to draw the line where it can actually hold: **E2E and CI run against `wrangler dev`, in workerd.** The Node dev server is a convenience whose behavior no requirement depends on. That preserves the substance of the parity argument — nothing ships on a runtime no test exercised — while admitting the HMR loop runs somewhere else.

Worth being clear-eyed: this is weaker than "dev is prod." A bug that only appears in workerd will be caught by CI rather than by the developer who wrote it, which is a slower and more annoying feedback loop. It's the price of this host, and it's payable because the E2E suite (AR-TEST-9) has to drive a real browser against a real server anyway.

**Resolved 2026-07-17: `wrangler dev` works offline.** Run with the network genuinely down, workerd started and served a full SSR page. The 2026-07-16 proxy attempt was inconclusive (undici ignores `HTTP_PROXY`), so this took a real network-off run — and it passed. AR-TEST-2 holds for the runtime layer; see [TESTING.md](TESTING.md) §2.

---

## 6. Release (AR-DEPLOY-2)

Push to `main` → production. Pull request → preview deployment. Both gated on CI (see [TESTING.md](TESTING.md) §12): a red suite never deploys. With no staging, that gate is the only thing between a bad commit and users.

Secrets (AR-DEPLOY-6) live in Cloudflare's secret store and in CI, never in the repo. Local and prod use the same key style — **publishable/secret** (`sb_publishable_…`, `sb_secret_…`), not the legacy anon/service-role names. These are **not JWTs**: send them on the `apikey` header, never `Authorization: Bearer`. Legacy keys are deprecated targeting end of 2026.

---

## 7. Gotchas

Each of these produces a wrong decision, and each contradicts something widely repeated:

- **`bun.lockb` is dead.** Bun's lockfile has been **text** (`bun.lock`) since 1.2 — it diffs and reviews fine. The binary-lockfile objection is obsolete; don't use it.
- **"Bun 2.0" does not exist.** Blog posts dated May 2026 announcing it with detailed feature lists are **fabricated AI content**, including invented compatibility percentages. Latest stable is 1.3.14 (2026-05-13).
- **Corepack is gone from Node 25+.** Don't build a workflow that assumes it's bundled.
- **Vercel Hobby is non-commercial.** Vercel means $20/mo for this product.
- **Workers CPU time excludes network waits.** Don't optimize the wrong thing.
- **`@supabase/ssr` on Workers may not need `nodejs_compat` any more.** Widely-repeated advice (and Supabase's own issue tracker) says it does, and that the `Dynamic require of "stream" is not supported` error is the tell. But the 2026-07-16 spike ran both Supabase libraries under workerd with **`nodejs_als` only** — the flag `sv create` scaffolds — and served 200s with no such error. Plausibly the recent `compatibility_date` (2026-07-17) does the work. **Don't cargo-cult the flag**: if that error appears, add `nodejs_compat`; until then the scaffold's default is evidently enough. Caveat: the spike exercised client construction, cookies, and a query — not the full auth surface, so a deeper path could still want it.
- **The `tsc` bin collides** when TypeScript is aliased — confirmed in this repo: `node_modules/.bin/tsc` → 7.0.2 while `require('typescript')` → 6.0.3. That is the split we want, but by accident of bin-resolution order. Scripts call `node_modules/ts7/bin/tsc` explicitly (§4).
- **`svelte-check --tsgo` is broken** (4.7.3, both flags, both TS versions). The flag existing is not the same as the flag working.
- **Type-aware linting rides the TS6 API until 7.1** — typescript-eslint imports `typescript` (6.0.3 in our split), same constraint and same resolution as svelte-check. The dual install incidentally keeps lint working today.
- **`checkJs: false` is load-bearing — don't turn it back on.** The scaffold ships `checkJs: true`. With it, *both* `tsc` and `svelte-check` report ~568 errors in generated code after any build, and `exclude` does not help. The chain took `--explainFiles` to see:

  ```
  worker-configuration.d.ts                  ← listed in tsconfig "types"
    → imports ".svelte-kit/cloudflare/_worker"   (wrangler types derives Env from main)
      → imports "../cloudflare-tmp/manifest.js"
        → imports every compiled endpoint
  ```

  `wrangler types` generates a `worker-configuration.d.ts` that **imports the built worker**, because `wrangler.jsonc`'s `main` points at it. `exclude` only filters glob matching — it cannot stop files reached by *import resolution*. The trap is that it's invisible until someone builds, so `pnpm check` is green on a clean tree and red afterwards. We author TypeScript, so `checkJs` earns nothing and costs exactly this. (`tsconfig.json` also excludes the output dirs — belt and braces, but `checkJs: false` is what actually fixes it.)
- **`sv create` writes a `README.md`** and names the project after the directory. Both were fixed by hand here; watch for it if the scaffold is ever re-run.
- **`sv create` addon syntax**: `+` separates options, `,` separates multiselect values — `--add "vitest=usages:unit,component"`. Getting it wrong drops you into an interactive prompt that fails in CI.
- **`@supabase/server` (v1.4.0, 2026-07-14) is not a replacement for `@supabase/ssr`.** It's stateless header-based auth for Workers/Edge; `@supabase/ssr` is cookie sessions for SvelteKit. Possibly useful for the token endpoint; **not** for `hooks.server.ts`.
- **pnpm settings left `.npmrc`** in v11. That file is auth/registry only now.
- **SvelteKit config is moving into `vite.config.js`** (2.62.0+) as a SvelteKit 3 preview, with `svelte.config.js` going away. Adopt on greenfield and skip the migration. Explicit env-var declaration (2.63.0) is the same story.
- **npm v12 breaks things deliberately**: install scripts off, `npm shrinkwrap` removed, unknown flags now throw instead of warn. Relevant if we ever retreat from pnpm.

---

## 8. Revisit triggers

- **Bun runtime** — reconsider when v1.4.0 (the Rust port) has been stable for several months **and** [bun#4145](https://github.com/oven-sh/bun/issues/4145) (Vitest) closes **and** a maintained SvelteKit adapter exists. None is true today; the current adapter is 9 months stale with an open deprecation issue, and Bun's own docs still recommend it. Note `bun install` alone — install with Bun, run everything on Node — remains a legitimate option we declined for pnpm's cooldown defaults, not because it doesn't work.
- **svelte-check on TS7** — when **7.1** ships the programmatic API. Re-test `--tsgo` then too; it exists today but is broken (§4).
- **Dev-time parity** — if `@cloudflare/vite-plugin` adds SvelteKit support, AR-DEPLOY-4 can be strengthened from "tests run in workerd" back to "dev runs in workerd." Worth watching: the plugin is actively developed (published 2026-07-15), so this could change.
- **Node 26** — after **2026-10-28**, when it enters LTS. Remember Corepack won't be there.
- **Hosting** — if AR-DEPLOY-3's CI measurements drift toward 3 MB or 10 ms, or if Workers' free tier changes. The fallback is already named and AR-DEPLOY-5 exists to keep the switch cheap.
- **This file's dates** — anything here older than ~6 months should be re-verified before it's used to make a decision. The last pass found five things that had changed within eight days.
