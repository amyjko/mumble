import { describe, expect, it } from 'vitest';
import { canvasObjectSchema, envelopeSchema, parseJson } from './schemas';

describe('envelope (the stale-tab boundary)', () => {
	it('accepts a well-formed v1 hello', () => {
		expect(envelopeSchema.safeParse({ v: 1, t: 'hello' }).success).toBe(true);
	});

	it('rejects an unknown protocol version — a stale tab is silently ignored', () => {
		expect(envelopeSchema.safeParse({ v: 2, t: 'hello' }).success).toBe(false);
	});

	it('rejects malformed junk without throwing', () => {
		for (const junk of [null, 42, 'state', {}, { t: 'state' }, { v: 1, t: 'state', state: 7 }]) {
			expect(envelopeSchema.safeParse(junk).success).toBe(false);
		}
	});
});

describe('canvas object discriminated union', () => {
	const base = {
		id: '33333333-3333-4333-8333-333333333333',
		creator_id: '11111111-1111-4111-8111-111111111111',
		permission: 'all',
		transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0, z: 1 },
		clip: { shape: 'rect' },
		border: { width: 10 },
		default_transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0, z: 1 },
		created_at: '2026-07-17T00:00:00.000Z',
		updated_at: '2026-07-17T00:00:00.000Z'
	};

	it('accepts a note with a note payload', () => {
		const parsed = canvasObjectSchema.safeParse({ ...base, type: 'note', payload: { text: 'hi' } });
		expect(parsed.success).toBe(true);
	});

	it('rejects a mismatched type/payload pair', () => {
		const parsed = canvasObjectSchema.safeParse({ ...base, type: 'note', payload: { seconds: 60 } });
		expect(parsed.success).toBe(false);
	});

	it('rejects non-positive dimensions', () => {
		const bad = { ...base, type: 'note', payload: { text: '' }, transform: { ...base.transform, width: 0 } };
		expect(canvasObjectSchema.safeParse(bad).success).toBe(false);
	});
});

describe('parseJson laundering', () => {
	it('returns unknown that a schema must vouch for', () => {
		const value = parseJson('{"v":1,"t":"hello"}');
		expect(envelopeSchema.safeParse(value).success).toBe(true);
	});
});
