import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AR-STYLE-1: components use tokens, never raw color literals — so a new
 * component cannot quietly defect from the design system or its contrast
 * guarantees. app.css is the single sanctioned home for color values.
 */

const ROOT = new URL('../../..', import.meta.url).pathname;
const SCAN_ROOT = join(ROOT, 'src');
const EXEMPT = new Set([
	join(SCAN_ROOT, 'app.css'), // the token source of truth
	join(SCAN_ROOT, 'lib/database.types.ts') // generated
]);

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (/\.(svelte|ts|css)$/.test(path) && !path.includes('.spec.')) out.push(path);
	}
	return out;
}

describe('no raw color literals outside app.css', () => {
	const files = walk(SCAN_ROOT).filter((f) => !EXEMPT.has(f));
	it.each(files.map((f) => [f.replace(ROOT, '')] as const))('%s', (rel) => {
		const content = readFileSync(join(ROOT, rel), 'utf8');
		const offending = content
			.split('\n')
			.map((line, i) => ({ line, n: i + 1 }))
			.filter(({ line }) => COLOR_LITERAL.test(line));
		expect(offending, offending.map(({ n, line }) => `${String(n)}: ${line.trim()}`).join('\n')).toEqual([]);
	});
});
