import { describe, expect, it } from 'vitest';
import { normalizePoints, pointsToPath, simplify, strokeBounds } from './drawing';
import { drawingObjectSchema } from './schemas';

describe('drawing helpers (UX-OBJ-11)', () => {
	it('strokeBounds covers the points with padding', () => {
		const b = strokeBounds([{ x: 10, y: 20 }, { x: 30, y: 60 }], 5);
		expect(b.x).toBe(5);
		expect(b.y).toBe(15);
		expect(b.width).toBe(30); // (30-10) + 5*2
		expect(b.height).toBe(50); // (60-20) + 5*2
	});

	it('normalizePoints maps into 0–100 of the box', () => {
		const box = { x: 0, y: 0, width: 200, height: 100 };
		const n = normalizePoints([{ x: 0, y: 0 }, { x: 200, y: 100 }, { x: 100, y: 50 }], box);
		expect(n).toEqual([{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 50, y: 50 }]);
	});

	it('pointsToPath emits an M/L path', () => {
		expect(pointsToPath([{ x: 0, y: 0 }, { x: 50, y: 50 }])).toBe('M 0 0 L 50 50');
		expect(pointsToPath([])).toBe('');
	});

	it('simplify drops points closer than the threshold', () => {
		const pts = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 5, y: 0 }];
		expect(simplify(pts, 2)).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }]);
	});

	it('schema rejects an unsafe color', () => {
		const base = { color: 'url(x)', width: 3, points: [{ x: 0, y: 0 }] };
		expect(
			drawingObjectSchema.safeParse({
				id: '11111111-1111-4111-8111-111111111111',
				creator_id: '11111111-1111-4111-8111-111111111111',
				permission: 'all',
				transform: { x: 0, y: 0, width: 10, height: 10, rotation: 0, z: 1 },
				clip: { shape: 'rect' },
				border: { width: 0 },
				type: 'drawing',
				payload: base,
				created_at: '2026-07-18T00:00:00.000Z',
				updated_at: '2026-07-18T00:00:00.000Z'
			}).success
		).toBe(false);
	});
});
