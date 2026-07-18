import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';

/**
 * AR-STYLE-3 / UX-A11Y-1: the palette's WCAG 2.2 AA claims are computed, not
 * eyeballed. Parses app.css's light-dark() tokens and asserts every declared
 * pair in BOTH themes. A token edit that breaks contrast fails the build.
 */

const css = readFileSync(new URL('../../app.css', import.meta.url), 'utf8');

function token(name: string): { light: string; dark: string } {
	const re = new RegExp(`--${name}:\\s*light-dark\\((#[0-9a-fA-F]+),\\s*(#[0-9a-fA-F]+)\\)`);
	const match = re.exec(css);
	if (!match || match[1] === undefined || match[2] === undefined) {
		throw new Error(`token --${name} not found or not a plain light-dark() pair`);
	}
	return { light: match[1], dark: match[2] };
}

/** [foreground, background, minimum ratio] — the design system's contract. */
const PAIRS: [string, string, number][] = [
	// Text: WCAG 1.4.3 requires 4.5:1
	['text', 'surface', 4.5],
	['text', 'surface-2', 4.5],
	['text', 'bg-canvas', 4.5],
	['text-muted', 'surface', 4.5],
	['text-muted', 'surface-2', 4.5],
	['accent', 'surface', 4.5],
	['accent-contrast', 'accent', 4.5],
	['danger', 'surface', 4.5],
	['note-text', 'note', 4.5],
	['sticker-text', 'sticker', 4.5],
	// Non-text UI: WCAG 1.4.11 requires 3:1
	['border-strong', 'surface', 3],
	['focus-ring', 'surface', 3],
	['focus-ring', 'bg-canvas', 3]
];

describe.each(['light', 'dark'] as const)('%s theme', (mode) => {
	it.each(PAIRS)('--%s on --%s ≥ %s:1', (fg, bg, minimum) => {
		const ratio = contrastRatio(token(fg)[mode], token(bg)[mode]);
		expect(ratio).not.toBeNull();
		expect(ratio ?? 0).toBeGreaterThanOrEqual(minimum);
	});
});
