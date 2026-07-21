import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The shared machinery behind this project's "never write X" guardrails.
 *
 * Several requirements state a rule nobody can hold in their head across a
 * growing surface — no provider names above the transport seam
 * (AR-TRANSPORT-10), no raw colours outside app.css (AR-STYLE-1), no Postgres
 * Changes (AR-BACKEND-3), no recording (UX-ROOM-7), no host-specific bindings
 * above the boundary (AR-DEPLOY-5). Each is enforced by a spec that walks
 * `src/` and greps. The walking and comment-stripping are identical every time;
 * only the pattern and the exemptions differ, and those are the parts worth
 * reading.
 *
 * Extracted when the fourth, fifth and sixth such rules arrived at once. Three
 * copies was tolerable; six would be the shape this codebase keeps paying for —
 * "near-identical copies where a correction has to be applied twice and the
 * second is missed", as `deferred.svelte.ts` puts it.
 *
 * The three ORIGINAL guardrails (no-provider-names, no-raw-color, no-raw-emoji)
 * deliberately still carry their own walkers. Each differs in a small way — file
 * extensions, whether `<style>` is stripped, whether specs are skipped — and
 * rewriting three working guardrails to share this would risk making one
 * vacuous for no behavioural gain. Folding them in is a separate, safe-to-review
 * cleanup rather than a thing to do while adding rules.
 */

/** The `src/` directory, resolved from a caller inside `src/lib/...`. */
export const SRC_ROOT = new URL('../..', import.meta.url).pathname;

export interface ScanOptions {
	/** Which files to read. Defaults to TypeScript and Svelte sources. */
	extensions?: RegExp;
	/** Paths (relative to `src/`) this rule does not apply to. */
	exempt?: (relative: string) => boolean;
}

/** A file the scan will check, with its path relative to `src/`. */
export interface ScannedFile {
	relative: string;
	absolute: string;
}

const DEFAULT_EXTENSIONS = /\.(ts|svelte)$/;

/**
 * Every source file a rule should be checked against.
 *
 * `node_modules` and `.svelte-kit` are skipped: generated and vendored code is
 * nobody's rule to keep, and `.svelte-kit` in particular contains copies of this
 * project's own files that would report every violation twice.
 */
export function sourceFiles(options: ScanOptions = {}): ScannedFile[] {
	const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
	const found: ScannedFile[] = [];

	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (entry === 'node_modules' || entry === '.svelte-kit') continue;
			const absolute = join(dir, entry);
			if (statSync(absolute).isDirectory()) walk(absolute);
			else if (extensions.test(entry)) {
				found.push({ absolute, relative: absolute.slice(SRC_ROOT.length) });
			}
		}
	};
	walk(SRC_ROOT);

	const exempt = options.exempt ?? (() => false);
	return found.filter((file) => !exempt(file.relative));
}

/**
 * A file's CODE, with comments removed.
 *
 * Prose may discuss a banned mechanism freely — explaining why the seam hides a
 * peer connection, or why Postgres Changes is refused, is exactly the kind of
 * comment this codebase wants, and a checker that forbade it would push the
 * reasoning out of the files that need it most.
 */
export function codeOf(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/[^\n]*/g, '');
}

/**
 * Lines of a file matching a banned pattern, formatted for an assertion message.
 *
 * Returns strings rather than booleans so a failure names the line and its
 * number; a guardrail that only says "this file is wrong" sends the next person
 * hunting.
 */
export function offendingLines(file: ScannedFile, pattern: RegExp): string[] {
	return codeOf(readFileSync(file.absolute, 'utf8'))
		.split('\n')
		.map((line, index) => ({ line: line.trim(), number: index + 1 }))
		.filter(({ line }) => pattern.test(line))
		.map(({ line, number }) => `${String(number)}: ${line}`);
}
