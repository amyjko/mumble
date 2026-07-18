import { describe, expect, it } from 'vitest';
import { CLIP_CYCLE, clipPathCss, hexagon, nextClip } from './clip';
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
