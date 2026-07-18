import { describe, expect, it } from 'vitest';
import { BACKGROUND_PRESETS, isSafeBackground } from './background';

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

	it('every shipped preset is itself safe', () => {
		for (const p of BACKGROUND_PRESETS) expect(isSafeBackground(p.value), p.name).toBe(true);
	});
});
