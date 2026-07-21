# mumble

A playful, customizable virtual meeting platform for small remote and hybrid groups.

A room is a **canvas**. People are avatars you can move, resize and reshape;
notes, timers, chat and drawings are objects on the same surface. Audio and video
ride peer-to-peer connections between participants, so a small room costs almost
nothing to run.

## Getting started

```bash
nvm use              # Node 24 — see the trap below, this is not optional
pnpm install
supabase start       # first run pulls Docker images; needs network once
cp .env.example .env # then fill in what `supabase start` printed
pnpm dev
```

**The one trap.** `pnpm` is pinned via `packageManager`, and running a command
with the wrong Node bootstraps a different pnpm that then disagrees with the
lockfile. `nvm use` first, every time. If `pnpm install` does something
surprising, that is the first thing to check.

`.env` is gitignored. `.env.example` lists every variable with empty values and a
comment explaining what each is for; nothing in it is a secret.

## Testing

The layers are the strategy — each proves something the others structurally
cannot, and [TESTING.md](TESTING.md) explains why. In rough order of speed:

```bash
pnpm run check            # lint, TypeScript, svelte-check
pnpm run test:unit        # pure logic + real-Chromium component tests
pnpm run test:rls         # pgTAP permission matrix, needs supabase start
pnpm run test:integration # real Supabase: auth claims, sessions, signalling RLS
pnpm run test:e2e         # Playwright against wrangler dev — the production runtime
pnpm run coturn && pnpm run test:relay   # the TURN relay path
```

`pnpm test` runs everything except the relay layer, which needs a local TURN
server. `pnpm run coturn` starts one — and installs coturn if it is missing, so
there is no prerequisite to remember.

Two things are worth knowing before trusting a green run:

- **E2E targets `wrangler dev`, not `vite dev`.** SvelteKit's dev server is Node
  and production is workerd; the E2E layer is where that runtime gets exercised
  at all.
- **What local cannot prove is written down**, not left implied — NAT traversal,
  the relay fraction, intercontinental latency, real provider handshakes. See
  AR-TEST-10 in [DESIGN.md](DESIGN.md).

## The documents

| File | What it is for |
| --- | --- |
| [DESIGN.md](DESIGN.md) | Every requirement, with a status tag and what is actually true about it. The project's memory. |
| [TESTING.md](TESTING.md) | The testing layers, what each proves, and the local setup. |
| [STACK.md](STACK.md) | Stack decisions and the versions they were verified against. |
| [STYLE.md](STYLE.md) | The design system and its accessibility claims. |
| [CONTROL-PLANE.md](CONTROL-PLANE.md) | How auth, membership, room state and the write path fit together — and the defects testing found in them. |

DESIGN.md is the one to read first, and its status tags are meant to be honest
rather than flattering: `_PARTIAL_` usually means "works, and here is precisely
what has never been tested".
