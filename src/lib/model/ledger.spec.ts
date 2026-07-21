import { describe, expect, it } from 'vitest';
import {
	beatSeconds,
	budgetReadout,
	BUDGET_WARNING_SECONDS,
	formatDuration,
	isExhausted,
	STALE_AFTER_SECONDS
} from './ledger';

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

/**
 * One rounding rule, shared by the room footnote and the account page
 * (UX-ID-10). Two surfaces showing one budget must not disagree about it, and
 * they would the first time somebody wrote `Math.round` in a template.
 */
describe('formatDuration', () => {
	it('reads in hours at an hour and above, minutes below', () => {
		expect(formatDuration(10 * 3600)).toBe('10h');
		expect(formatDuration(3600)).toBe('1h');
		expect(formatDuration(3599)).toBe('59m');
		expect(formatDuration(60)).toBe('1m');
	});

	it('always rounds DOWN, so a duration is a floor and not a hope', () => {
		expect(formatDuration(3 * 3600 - 60)).toBe('2h');
		expect(formatDuration(119)).toBe('1m');
		expect(formatDuration(59)).toBe('0m');
	});

	it('never reports a negative duration', () => {
		expect(formatDuration(-600)).toBe('0m');
	});
});

/**
 * The toolbar footnote (UX-ECON-2).
 *
 * The phrasing is tested rather than eyeballed because it makes a PROMISE: the
 * number is what the room actually has left, and the gate that enforces it uses
 * the same seconds. A readout that rounds up promises time the room cannot give.
 */
describe('budgetReadout', () => {
	const CAP = 36000; // ten hours

	it('reads in hours while there is plenty', () => {
		expect(budgetReadout(0, CAP).label).toBe('10h left this week');
		expect(budgetReadout(0, CAP).warning).toBe(false);
	});

	it('rounds DOWN, so the number is a floor and not a hope', () => {
		// 2h 59m left must not read "3h". Rounding up in the user's disfavour is
		// the one direction that turns the readout into a false promise.
		const almostThree = CAP - (3 * 3600 - 60);
		expect(budgetReadout(almostThree, CAP).label).toBe('2h left this week');
	});

	it('switches to minutes exactly at the warning threshold', () => {
		// The unit change is a second, non-colour signal for the same event
		// (WCAG 1.4.1), so it has to happen at precisely the same moment.
		const atThreshold = CAP - BUDGET_WARNING_SECONDS;
		expect(budgetReadout(atThreshold, CAP).warning).toBe(false);
		expect(budgetReadout(atThreshold, CAP).label).toBe('1h left this week');

		const justUnder = CAP - BUDGET_WARNING_SECONDS + 1;
		expect(budgetReadout(justUnder, CAP).warning).toBe(true);
		expect(budgetReadout(justUnder, CAP).label).toBe('59m left this week');
	});

	it('says "no time left" rather than rounding the last seconds up', () => {
		// 30 seconds left is not "1m left". The room is about to refuse people.
		expect(budgetReadout(CAP - 30, CAP).label).toBe('0m left this week');
		expect(budgetReadout(CAP, CAP).label).toBe('no time left this week');
		expect(budgetReadout(CAP, CAP).exhausted).toBe(true);
	});

	it('never reports negative time when a cap is lowered below what is spent', () => {
		// An operator can set `weekly_cap_seconds` by hand, including below the
		// current usage. "-2h left" would be a readout nobody can act on.
		const readout = budgetReadout(CAP, 3600);
		expect(readout.secondsLeft).toBe(0);
		expect(readout.exhausted).toBe(true);
		expect(readout.label).toBe('no time left this week');
	});

	it('treats a zero cap as exhausted, matching the gate', () => {
		// The suspended-room case. The footnote and `isExhausted` must agree, or
		// the bar says one thing while the door does another.
		expect(budgetReadout(0, 0).exhausted).toBe(true);
		expect(isExhausted(0, 0)).toBe(true);
	});
});
