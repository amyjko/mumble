import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every emoji must render through Emoji.svelte, which applies --font-emoji.
 *
 * Sibling of no-raw-color.spec.ts, and for the same reason: "always use the
 * emoji font" is a rule nobody can hold in their head across a growing
 * surface. Before this, only the avatar face set the font, so the reaction
 * picker and the raised-hand badge quietly rendered in the system emoji set —
 * defeating the point of vendoring Noto Color Emoji for cross-platform
 * consistency.
 *
 * A literal emoji in component MARKUP fails. Glyphs belong in data modules
 * (model/emotes.ts, model/identity.ts), which components render through
 * <Emoji>.
 */

const SRC = new URL('../..', import.meta.url).pathname;

/**
 * Emoji-presentation codepoints. Deliberately NOT matching dingbats and
 * arrows in the Miscellaneous Symbols block (✎ ↺ ⛶ ✕ ◇ ▾), which render as
 * text glyphs in the UI font and are not emoji — the theme toggle's ◐☀☾ are
 * the same case, already noted in STYLE.md.
 */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F0FF}\u{2728}\u{270B}\u{2764}]/u;

/** Glyph data lives in these; components render it through <Emoji>. */
const DATA_MODULES = ['model/emotes.ts', 'model/identity.ts', 'model/palette.ts'];

function svelteFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			svelteFiles(full, out);
		} else if (entry.endsWith('.svelte')) {
			out.push(full);
		}
	}
	return out;
}

/** Strip comments and the <style> block: prose may mention emoji freely. */
function markupOf(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/[^\n]*/g, '')
		.replace(/<style[\s\S]*?<\/style>/g, '');
}

describe('no raw emoji in components (AR-STYLE-1)', () => {
	const files = svelteFiles(SRC).filter((f) => !f.endsWith('Emoji.svelte'));

	it('finds components to check', () => {
		expect(files.length).toBeGreaterThan(5);
	});

	it.each(files.map((f) => [f.slice(SRC.length), f] as const))(
		'%s renders emoji through <Emoji>',
		(_name, file) => {
			const offending = markupOf(readFileSync(file, 'utf8'))
				.split('\n')
				.map((line, i) => ({ line, number: i + 1 }))
				.filter(({ line }) => EMOJI.test(line));
			expect(offending.map((o) => `${String(o.number)}: ${o.line.trim()}`)).toEqual([]);
		}
	);

	it('the glyph data modules exist to hold them instead', () => {
		for (const module of DATA_MODULES) {
			const source = readFileSync(join(SRC, 'lib', module), 'utf8');
			expect(source.length).toBeGreaterThan(0);
		}
	});
});
