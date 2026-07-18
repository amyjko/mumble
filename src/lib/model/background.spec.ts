import { describe, expect, it } from 'vitest';
import { BACKGROUND_GRADIENTS, BACKGROUND_LEVELS, isSafeBackground } from './background';

describe('isSafeBackground (UX-CANVAS-5 injection guard)', () => {
	it('accepts colors, gradients, and tokens', () => {
		for (const v of [
			'',
			'var(--surface)',
			'#ff8800',
			'rgb(10, 20, 30)',
			'linear-gradient(160deg, var(--surface), var(--surface-2))',
			'radial-gradient(circle at 50% 30%, var(--surface), var(--bg-canvas))'
		]) {
			expect(isSafeBackground(v), v).toBe(true);
		}
	});

	it('REJECTS anything that could fetch or smuggle declarations', () => {
		for (const v of [
			'url(https://evil.example/x.png)',
			'red; position: fixed',
			'image-set("a.png" 1x)',
			'var(--x); background: url(//evil)',
			'expression(alert(1))',
			'</style><script>',
			'a'.repeat(401)
		]) {
			expect(isSafeBackground(v), v).toBe(false);
		}
	});

	it('every shipped brightness level is itself safe', () => {
		for (const level of BACKGROUND_LEVELS) expect(isSafeBackground(level.value), level.name).toBe(true);
	});

	it('every shipped gradient is itself safe', () => {
		// The sanitizer already permitted gradients; this pins that the ones we
		// actually ship pass it, so a future gradient using url() or a stray
		// semicolon cannot slip in beside them.
		for (const g of BACKGROUND_GRADIENTS) expect(isSafeBackground(g.value), g.name).toBe(true);
	});

	it('gradients are built only from the contrast-checked ramp', () => {
		// A gradient composed of arbitrary colours could put text on a surface
		// theme-contrast.spec.ts has never vouched for. Restricting them to
		// --bg-level-* tokens is what keeps the contrast guarantee intact.
		for (const g of BACKGROUND_GRADIENTS) {
			const tokens = g.value.match(/var\(--[a-z0-9-]+\)/g) ?? [];
			expect(tokens.length, g.name).toBeGreaterThan(0);
			for (const token of tokens) expect(token, g.name).toMatch(/^var\(--bg-level-[1-5]\)$/);
		}
	});
});

describe('BACKGROUND_LEVELS (the brightness ramp users pick from)', () => {
	it('offers the room default plus one entry per ramp token', () => {
		expect(BACKGROUND_LEVELS[0]?.value).toBe('');
		const levels = BACKGROUND_LEVELS.slice(1);
		expect(levels).toHaveLength(5);
		levels.forEach((level, i) => {
			expect(level.value).toBe(`var(--bg-level-${String(i + 1)})`);
		});
	});

	it('names carry the ORDER, so the choice is not color-only', () => {
		// A picker made of near-identical shades cannot rely on appearance to
		// convey rank (WCAG 1.4.1) — and the old names (Dawn, Spotlight) carried
		// no order at all. Every level names its position.
		const levels = BACKGROUND_LEVELS.slice(1);
		levels.forEach((level, i) => {
			expect(level.name).toContain(String(i + 1));
		});
		expect(levels[0]?.name).toContain('dimmest');
		expect(levels[4]?.name).toContain('brightest');
	});
});
