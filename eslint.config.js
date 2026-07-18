import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	{
		// Generated files: machine output is exempt — the norms govern what we write.
		ignores: ['worker-configuration.d.ts', 'src/lib/database.types.ts']
	},
	js.configs.recommended,
	// STACK.md §4 norms: strict typing, no dodging. Type-checked so `any` is caught
	// LEAKING through calls (the no-unsafe-* family), not just where it's written.
	ts.configs.strictTypeChecked,
	svelte.configs.recommended,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
			parserOptions: {
				projectService: {
					// Config files no tsconfig claims; type-aware linting still applies.
					allowDefaultProject: ['eslint.config.js', 'playwright.config.ts', 'e2e/*.ts']
				},
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off',
			// The norms (STACK.md §4). `as` is banned outright: unsafe boundaries are
			// laundered any→unknown and parsed with zod, never asserted.
			'@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
			// ts-expect-error directives require a written reason; ts-ignore/ts-nocheck never.
			'@typescript-eslint/ban-ts-comment': [
				'error',
				{
					'ts-expect-error': { descriptionFormat: '^: .+$' },
					'ts-ignore': true,
					'ts-nocheck': true
				}
			]
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	}
);
