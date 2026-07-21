/**
 * How many seconds one heartbeat is worth (AR-COST-3, UX-ECON-2).
 *
 * Pure, and separated from the route for the reason `confirm.ts` was: the
 * arithmetic is the part with edge cases, and it should be testable in node
 * without a request, a database or a clock (AR-TEST-4).
 *
 * THE HEARTBEAT IS THE METER, and that is the design rather than a convenience.
 * The obvious alternative — open an interval on join, close it on leave, bill
 * the difference — is wrong for exactly the case UX-ECON-2 names: usage must be
 * "metered reliably even across crashes", and a crash is precisely when the
 * leave event does not arrive. An interval-based meter bills a crashed tab zero
 * or forever depending on which way you round it. A beat-based meter bills what
 * was actually observed, because every credited second is one where somebody
 * said "I am still here".
 */

/**
 * Three missed beats at the client's ~15s cadence — the staleness rule, and the
 * metering clamp, which are ONE number and must stay one.
 *
 * It began as the liveness threshold: the point past which the sweep stops
 * believing you are here (AR-CTRL-3, UX-STAGE-4). Generous on purpose, because
 * reaping someone on a slow network takes the conch from a person still sitting
 * in the room.
 *
 * It is the metering clamp for the same reason, not by coincidence. A beat
 * credits the time since the last beat, so a tab that slept for an hour would
 * otherwise credit an hour nobody was present for. The most a beat may claim is
 * the longest gap the reaper is still willing to call "present" — a meter that
 * trusted a longer gap would bill for participants the room had already given
 * up on, and one that trusted a shorter gap would undercount every slow
 * network. Two constants that must agree are one constant.
 *
 * Lives here rather than in the heartbeat route so that both the route and this
 * arithmetic can see it; a route cannot be imported from a model.
 */
export const STALE_AFTER_SECONDS = 45;

/**
 * Seconds to credit for a beat, given when the beater was last seen.
 *
 * Returns 0 rather than a negative number when the clock runs backwards. That
 * is not defensive noise: `last_seen` is written by the server, but "the
 * server" is several isolates whose clocks agree only approximately, so a beat
 * arriving with a timestamp fractionally before its predecessor is ordinary.
 * Crediting a negative would REFUND time, which is a cap that leaks.
 *
 * A first beat (no previous `last_seen`) is worth nothing. There is no elapsed
 * presence to bill yet, and inventing one would bill every arrival for a beat
 * interval they had not yet spent.
 */
export function beatSeconds(lastSeen: Date | null, now: Date): number {
	if (lastSeen === null) return 0;
	const elapsed = (now.getTime() - lastSeen.getTime()) / 1000;
	if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
	return Math.min(Math.floor(elapsed), STALE_AFTER_SECONDS);
}

/**
 * Has this account used its week? (AR-COST-4)
 *
 * `>=`, not `>`: AR-COST-4 says "refuse a join when `weekly_seconds_used >=
 * weekly_cap_seconds`", and the boundary matters at the one cap that is set by
 * hand — a cap of 0 must refuse everyone, which `>` would not.
 */
export function isExhausted(used: number, cap: number): boolean {
	return used >= cap;
}

/**
 * When the readout starts asking to be noticed, in seconds.
 *
 * An hour. Long enough that a room can finish the meeting it is in and still
 * have the conversation about it; short enough that it is not permanently
 * amber, which is the failure mode of a warning set too early — a colour that
 * is always on is a colour nobody reads.
 */
export const BUDGET_WARNING_SECONDS = 3600;

/** What the toolbar needs to render, derived in one place rather than in markup. */
export interface BudgetReadout {
	/** Never negative: a cap lowered below what is already spent is 0 left, not -3h. */
	secondsLeft: number;
	/** "3h left" / "45m left" / "no time left" — the footnote itself. */
	label: string;
	/** Under an hour, so the readout should change colour and say more. */
	warning: boolean;
	/** Nothing left at all: the room is closed to new arrivals right now. */
	exhausted: boolean;
}

/**
 * The room's remaining time, phrased for a footnote (UX-ECON-2).
 *
 * Rounding is DOWN, deliberately, and it is the only interesting decision here:
 * a readout that says "1h left" when 61 minutes remain is a small lie in the
 * user's favour, while one that says "1h" when 59 minutes remain promises time
 * the room does not have. Floor makes the number a guarantee rather than an
 * estimate — and it is what makes the last minute read "no time left" instead of
 * rounding up to a cheerful "1m".
 *
 * Hours above an hour, minutes below it. Nobody needs "2h 47m" for a budget
 * whose whole job is to say roughly how much room is left; the precision starts
 * mattering exactly when the warning does.
 */
export function budgetReadout(usedSeconds: number, capSeconds: number): BudgetReadout {
	const secondsLeft = Math.max(0, capSeconds - usedSeconds);
	const warning = secondsLeft < BUDGET_WARNING_SECONDS;
	const exhausted = secondsLeft === 0;

	const label = exhausted
		? 'no time left this week'
		: warning
			? `${String(Math.floor(secondsLeft / 60))}m left this week`
			: `${String(Math.floor(secondsLeft / 3600))}h left this week`;

	return { secondsLeft, label, warning, exhausted };
}
