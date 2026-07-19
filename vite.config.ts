import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					// Load the design tokens into the test page. Components resolve
					// every size and color from app.css; without it a rule like
					// `width: var(--control-height)` is invalid and the element
					// collapses to content width — so a component test would be
					// measuring a component that cannot exist in the real app.
					setupFiles: ['./src/lib/test/browser-setup.ts'],
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			/*
			 * Integration: needs the local Supabase stack running. NOT in the
			 * default run — `pnpm test:unit` must stay offline and fast, and a
			 * developer without Docker should not see a wall of red. Run with
			 * `pnpm test:integration`; CI runs it in the database job where the
			 * stack is already up.
			 */
			{
				extends: './vite.config.ts',
				test: {
					name: 'integration',
					environment: 'node',
					include: ['src/**/*.integration.spec.ts']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}', 'src/**/*.integration.spec.ts']
				}
			}
		]
	}
});
