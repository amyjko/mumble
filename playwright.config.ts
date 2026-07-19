import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Load .env for the test PROCESS, not the app.
 *
 * The app gets these through SvelteKit's $env at build time; the helpers in
 * e2e/support run in plain Node and need them in process.env. Parsed by hand
 * rather than adding dotenv for four lines — and deliberately non-fatal, so a
 * checkout without a local stack still runs the tests that do not need one.
 */
try {
	for (const line of readFileSync('.env', 'utf8').split('\n')) {
		const eq = line.indexOf('=');
		if (eq <= 0 || line.startsWith('#')) continue;
		process.env[line.slice(0, eq).trim()] ??= line.slice(eq + 1).trim();
	}
} catch {
	// No .env: the auth helpers will explain themselves when used.
}

const ci = process.env.CI === 'true' || process.env.CI === '1';

/**
 * The preview port, overridable.
 *
 * 4173 is Vite's default, so it is exactly the port every OTHER project on this
 * machine also wants. `reuseExistingServer: false` means a collision is refused
 * rather than silently served — which is the right behaviour and cost real time
 * to diagnose anyway, because a request to a neighbour's app on the same port
 * answers with THAT app's 404 and reads as a bug in this one.
 *
 * Set MUMBLE_E2E_PORT to run alongside another project. `pnpm run preview`
 * reads the same variable, so the two cannot drift.
 */
const port = Number(process.env.MUMBLE_E2E_PORT ?? 4173);

export default defineConfig({
	// Checks the local stack BEFORE any test runs, so an unhealthy environment
	// reports itself in one line instead of as 60 failing assertions.
	globalSetup: './e2e/support/global-setup.ts',
	webServer: {
		// The BUILT worker under wrangler dev, never `vite dev` (AR-TEST-9 /
		// AR-DEPLOY-4): this is the only place the production runtime gets
		// exercised, so pointing E2E at the Node dev server for speed would
		// quietly void the parity guarantee.
		//
		// pnpm, not npm: the project is pnpm-only (packageManager pins 11.13.1)
		// and npm's runner happened to work by accident.
		command: 'pnpm run build && pnpm run preview',
		port,
		// A cold `wrangler types` + `vite build` + workerd start comfortably
		// exceeds Playwright's 60s default on a CI runner.
		timeout: 180_000,
		// NEVER reuse, even locally. The command BUILDS before serving, so
		// reusing a running server silently skips the rebuild and tests the
		// previous bundle. That is not hypothetical: it reported two green
		// full-suite runs against code that had already changed, and CI — where
		// reuse was already off — caught the failure I had just been told did
		// not exist. A ~10s rebuild is worth never again wondering whether a
		// green run meant anything.
		reuseExistingServer: false
	},
	testMatch: '**/*.e2e.{ts,js}',
	// Chromium only: AR-TEST-9's fake media devices are unsupported on WebKit,
	// and this layer exists to exercise one runtime honestly rather than three
	// shallowly.
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' } }],
	// CI runners are noisy neighbours; one retry separates a flake from a
	// failure without hiding a real one.
	retries: ci ? 1 : 0,
	// A stray .only must never silently shrink the suite that gates deploys.
	forbidOnly: ci,
	reporter: ci ? [['github'], ['html', { open: 'never' }]] : [['list']]
});
