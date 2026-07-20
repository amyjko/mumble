import { describe, expect, it } from 'vitest';
import { isPolite, signalSchema } from './signal';

/**
 * The signalling vocabulary and the rule that decides who yields.
 *
 * Pure, and tested here rather than through a peer connection, because a
 * collision is hard to provoke on purpose over loopback and trivial to reason
 * about as a comparison.
 */

describe('the politeness rule', () => {
	it('makes exactly one side of a pair polite', () => {
		// THE property. Both polite and neither connects (both roll back); both
		// impolite and neither connects (both ignore).
		const a = 'aaaaaaaa-1111-4111-8111-111111111111';
		const b = 'bbbbbbbb-2222-4222-8222-222222222222';
		expect(isPolite(a, b)).not.toBe(isPolite(b, a));
	});

	it('agrees with itself whichever end asks', () => {
		const a = 'endpoint-a';
		const b = 'endpoint-z';
		expect(isPolite(a, b)).toBe(true);
		expect(isPolite(b, a)).toBe(false);
	});

	it('is total over tabs of the SAME person', () => {
		/*
		 * The reason this compares endpoints rather than actors. Two tabs of one
		 * person share an actor id, so an actor comparison would tie — and a tie
		 * means both tabs answer the same offer, each with a competing answer for
		 * one connection.
		 */
		const actor = 'same-person';
		expect(isPolite(actor, actor)).toBe(false);
		const tabOne = `${actor}:aaa`;
		const tabTwo = `${actor}:bbb`;
		expect(isPolite(tabOne, tabTwo)).not.toBe(isPolite(tabTwo, tabOne));
	});
});

describe('parsing what a peer sent', () => {
	it('accepts a description', () => {
		const parsed = signalSchema.safeParse({ kind: 'description', type: 'offer', sdp: 'v=0' });
		expect(parsed.success).toBe(true);
	});

	it('refuses an sdp longer than the cap', () => {
		// Unbounded strings from peers are a gift to anyone who wants to spend
		// your memory.
		const parsed = signalSchema.safeParse({
			kind: 'description',
			type: 'offer',
			sdp: 'x'.repeat(64_001)
		});
		expect(parsed.success).toBe(false);
	});

	it('refuses a description that is neither offer nor answer', () => {
		const parsed = signalSchema.safeParse({ kind: 'description', type: 'rollback', sdp: 'v=0' });
		expect(parsed.success).toBe(false);
	});

	it('accepts candidates with explicit nulls', () => {
		// `.nullable()` rather than `.optional()`: these map onto W3C dictionaries
		// whose fields are `string | null`, and under exactOptionalPropertyTypes an
		// optional field cannot be spread into one that accepts null.
		const parsed = signalSchema.safeParse({
			kind: 'candidates',
			items: [{ candidate: 'candidate:1 1 udp', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null }]
		});
		expect(parsed.success).toBe(true);
	});

	it('refuses a candidate batch beyond the cap', () => {
		const one = { candidate: 'c', sdpMid: null, sdpMLineIndex: null, usernameFragment: null };
		expect(signalSchema.safeParse({ kind: 'candidates', items: Array(33).fill(one) }).success).toBe(
			false
		);
	});

	it('accepts a want, including the null that means stop', () => {
		expect(signalSchema.safeParse({ kind: 'want', media: 'video', layer: 'high' }).success).toBe(true);
		// `null` collapses unsubscribe and pause into one message.
		expect(signalSchema.safeParse({ kind: 'want', media: 'audio', layer: null }).success).toBe(true);
	});

	it('refuses a rung that is not on the ladder', () => {
		expect(signalSchema.safeParse({ kind: 'want', media: 'video', layer: 'ultra' }).success).toBe(
			false
		);
	});

	it('refuses an unknown kind rather than passing it through', () => {
		expect(signalSchema.safeParse({ kind: 'exec', payload: 'rm -rf' }).success).toBe(false);
	});

	it('refuses a non-object outright', () => {
		for (const junk of [null, 'offer', 42, []]) {
			expect(signalSchema.safeParse(junk).success).toBe(false);
		}
	});
});
