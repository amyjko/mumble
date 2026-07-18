import { defineConfig, devices } from '@playwright/test';

const ci = process.env.CI === 'true' || process.env.CI === '1';

export default defineConfig({
	webServer: {
		// The BUILT worker under wrangler dev, never `vite dev` (AR-TEST-9 /
		// AR-DEPLOY-4): this is the only place the production runtime gets
		// exercised, so pointing E2E at the Node dev server for speed would
		// quietly void the parity guarantee.
		//
		// pnpm, not npm: the project is pnpm-only (packageManager pins 11.13.1)
		// and npm's runner happened to work by accident.
		command: 'pnpm run build && pnpm run preview',
		port: 4173,
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
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	// CI runners are noisy neighbours; one retry separates a flake from a
	// failure without hiding a real one.
	retries: ci ? 1 : 0,
	// A stray .only must never silently shrink the suite that gates deploys.
	forbidOnly: ci,
	reporter: ci ? [['github'], ['html', { open: 'never' }]] : [['list']]
});
