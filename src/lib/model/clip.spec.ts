import { describe, expect, it } from 'vitest';
import { CLIP_CYCLE, clipPathCss, hexagon, nextClip, outlineFor } from './clip';
import type { Clip } from './types';
import { clipSchema } from './schemas';

describe('clip shapes (UX-OBJ-7)', () => {
	it('clipPathCss: percentage clip-path for ellipse/polygon, null for the radius shapes', () => {
		expect(clipPathCss({ shape: 'rect' })).toBeNull();
		expect(clipPathCss({ shape: 'rounded', radius: 8 })).toBeNull();
		expect(clipPathCss({ shape: 'circle' })).toBeNull();
		expect(clipPathCss({ shape: 'ellipse' })).toBe('ellipse(50% 50% at 50% 50%)');
		const poly = clipPathCss({ shape: 'polygon', points: hexagon() });
		expect(poly).toContain('polygon(');
		expect(poly).toContain('25% 0%');
	});

	it('nextClip cycles through every shape and wraps', () => {
		let clip: Clip = { shape: 'rect' };
		const seen = new Set<string>();
		for (let i = 0; i < CLIP_CYCLE.length; i++) {
			seen.add(clip.shape);
			clip = nextClip(clip);
		}
		expect(seen.size).toBe(CLIP_CYCLE.length);
		expect(clip.shape).toBe('rect'); // wrapped back to the first
	});

	it('schema accepts a valid polygon and rejects out-of-range / too-few points', () => {
		expect(clipSchema.safeParse({ shape: 'polygon', points: hexagon() }).success).toBe(true);
		expect(clipSchema.safeParse({ shape: 'polygon', points: [{ x: 0, y: 0 }, { x: 50, y: 50 }] }).success).toBe(false); // <3
		expect(clipSchema.safeParse({ shape: 'polygon', points: [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 200, y: 0 }] }).success).toBe(false); // x>100
	});
});

describe('outlineFor: a dashed edge that follows the shape (UX-AV-2)', () => {
	it('maps circle AND ellipse to one ellipse outline', () => {
		// `circle` is border-radius 50%, which paints an ellipse on a non-square
		// box. Treating them differently would make the outline disagree with
		// the thing it outlines.
		expect(outlineFor({ shape: 'circle' }, 200, 100)).toEqual({ kind: 'ellipse' });
		expect(outlineFor({ shape: 'ellipse' }, 200, 100)).toEqual({ kind: 'ellipse' });
	});

	it('carries a polygon through unchanged, so the dashes trace its edges', () => {
		const points = hexagon();
		expect(outlineFor({ shape: 'polygon', points }, 100, 100)).toEqual({ kind: 'polygon', points });
	});

	it('scales a rounded corner into the 0-100 box on BOTH axes', () => {
		// 20px is 10% of a 200px width but 20% of a 100px height. One value for
		// both would draw a circular corner where border-radius paints an
		// elliptical one, so the outline would disagree with the thing it
		// outlines on every non-square placer.
		expect(outlineFor({ shape: 'rounded', radius: 20 }, 200, 100)).toEqual({
			kind: 'rect',
			rx: 10,
			ry: 20
		});
	});

	it('a plain rect has no corner rounding at all', () => {
		expect(outlineFor({ shape: 'rect' }, 200, 100)).toEqual({ kind: 'rect', rx: 0, ry: 0 });
	});

	it('survives a zero-width box without dividing by zero', () => {
		// Placers are created before layout has measured anything, so a zero
		// dimension reaches this on the first frame. NaN in an SVG attribute
		// silently drops the outline rather than erroring.
		const out = outlineFor({ shape: 'rounded', radius: 8 }, 0, 0);
		expect(out.kind).toBe('rect');
		if (out.kind === 'rect') {
			expect(Number.isFinite(out.rx)).toBe(true);
			expect(Number.isFinite(out.ry)).toBe(true);
		}
	});
});
