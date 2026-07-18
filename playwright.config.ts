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
		// Locally, reuse a preview server that is already up; in CI always start
		// clean so a stale process can never serve an old bundle.
		reuseExistingServer: !ci
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
