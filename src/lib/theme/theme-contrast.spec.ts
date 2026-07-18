import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseHex, relativeLuminance } from './contrast';

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
	// Button's `chrome` variant inverts: --surface text on a --text badge.
	['surface', 'text', 4.5],
	// Non-text UI: WCAG 1.4.11 requires 3:1
	['border-strong', 'surface', 3],
	['focus-ring', 'surface', 3],
	['focus-ring', 'bg-canvas', 3],
	// The room brightness ramp (UX-CANVAS-5): a user can set any level as the
	// canvas background, so every level must hold text and focus contrast in
	// both themes — otherwise "brightness 1" is a legibility trap.
	['text', 'bg-level-1', 4.5],
	['text', 'bg-level-2', 4.5],
	['text', 'bg-level-3', 4.5],
	['text', 'bg-level-4', 4.5],
	['text', 'bg-level-5', 4.5],
	['focus-ring', 'bg-level-1', 3],
	['focus-ring', 'bg-level-2', 3],
	['focus-ring', 'bg-level-3', 3],
	['focus-ring', 'bg-level-4', 3],
	['focus-ring', 'bg-level-5', 3]
];

/**
 * The ramp's *ordering* is a semantic claim, not just a contrast one: "level 5
 * is brighter than level 1" has to be true in BOTH themes, or the control lies
 * about what it does. Asserted here because the light and dark ramps run in
 * opposite absolute directions (light walks toward white, dark walks up from
 * near-black), which is exactly the kind of thing that silently inverts.
 */
function luminanceOf(hex: string): number {
	const rgb = parseHex(hex);
	if (rgb === null) throw new Error(`unparseable color ${hex}`);
	return relativeLuminance(rgb);
}

describe.each(['light', 'dark'] as const)('%s brightness ramp is monotonic', (mode) => {
	it('each level is strictly brighter than the one below it', () => {
		const levels = [1, 2, 3, 4, 5].map((n) => luminanceOf(token(`bg-level-${String(n)}`)[mode]));
		for (let i = 1; i < levels.length; i++) {
			const previous = levels[i - 1];
			const current = levels[i];
			if (previous === undefined || current === undefined) throw new Error('missing level');
			expect(current).toBeGreaterThan(previous);
		}
	});
});

describe.each(['light', 'dark'] as const)('%s theme', (mode) => {
	it.each(PAIRS)('--%s on --%s ≥ %s:1', (fg, bg, minimum) => {
		const ratio = contrastRatio(token(fg)[mode], token(bg)[mode]);
		expect(ratio).not.toBeNull();
		expect(ratio ?? 0).toBeGreaterThanOrEqual(minimum);
	});
});
