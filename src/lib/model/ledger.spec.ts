import { describe, expect, it } from 'vitest';
import { beatSeconds, isExhausted, STALE_AFTER_SECONDS } from './ledger';

/**
 * What a heartbeat is worth (AR-COST-3, UX-ECON-2, AR-TEST-4).
 *
 * Pure arithmetic, so it is tested without a database, a request or a clock —
 * which is the point of extracting it. Every case below is one the route
 * genuinely produces: a first beat, a normal beat, a slept tab, and two clocks
 * that disagree about which came first.
 */
describe('beatSeconds', () => {
	const now = new Date('2026-07-20T12:00:00.000Z');
	const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

	it('credits nothing for a first beat', () => {
		// There is no elapsed presence to bill yet. Crediting an interval here
		// would bill every arrival for time they had not spent.
		expect(beatSeconds(null, now)).toBe(0);
	});

	it('credits the gap since the previous beat', () => {
		expect(beatSeconds(ago(15), now)).toBe(15);
	});

	it('clamps a long gap to the staleness threshold', () => {
		// A tab that slept for an hour: the reaper stopped believing this person
		// was present after 45 seconds, so the meter must not bill past it.
		expect(beatSeconds(ago(3600), now)).toBe(STALE_AFTER_SECONDS);
	});

	it('credits exactly the threshold at the threshold', () => {
		expect(beatSeconds(ago(STALE_AFTER_SECONDS), now)).toBe(STALE_AFTER_SECONDS);
	});

	it('credits nothing when the clock runs backwards', () => {
		// Several isolates whose clocks agree only approximately, so a beat
		// timestamped fractionally before its predecessor is ordinary. Crediting
		// a negative would REFUND time — a cap that leaks.
		expect(beatSeconds(new Date(now.getTime() + 5000), now)).toBe(0);
	});

	it('credits nothing for a zero-length gap', () => {
		expect(beatSeconds(now, now)).toBe(0);
	});

	it('floors rather than rounds, so a beat can never bill more than it saw', () => {
		expect(beatSeconds(new Date(now.getTime() - 15_900), now)).toBe(15);
	});

	it('credits nothing for an unparseable timestamp', () => {
		expect(beatSeconds(new Date('nonsense'), now)).toBe(0);
	});
});

describe('isExhausted', () => {
	it('refuses at the cap, not past it', () => {
		// AR-COST-4 says `weekly_seconds_used >= weekly_cap_seconds`, and the
		// boundary is load-bearing: a cap of 0 must refuse everyone, which a
		// strict `>` would not.
		expect(isExhausted(0, 0)).toBe(true);
		expect(isExhausted(36000, 36000)).toBe(true);
	});

	it('allows a budget with time left', () => {
		expect(isExhausted(35999, 36000)).toBe(false);
		expect(isExhausted(0, 36000)).toBe(false);
	});
});
