import { budgetReadout, type BudgetReadout } from '$lib/model/ledger';

/**
 * The room's remaining time this week, as last reported by the heartbeat
 * (UX-ECON-2, AR-COST-4).
 *
 * A module rather than a prop, for the same reason `deferredWork` is one: the
 * value is produced by the room page's beat and consumed by a footnote four
 * levels down (page → Room → BottomBar → EmoteBar), and threading it through
 * three components that have no interest in it would add a prop to each of
 * their interfaces to serve a single line of text.
 *
 * WHOSE time this is, since the phrasing hides a real decision: the ROOM's,
 * which is its owner's account (UX-ID-4). A guest holds no account and accrues
 * nothing, so showing a viewer their OWN budget would be true and useless — a
 * full ten hours that never moves, while the room can shut around them at the
 * owner's zero. The number everyone sees is the one that actually governs
 * whether the room stays open.
 *
 * Null until the first beat answers, which is deliberate: a readout that
 * defaults to a full week would flash "10h left" at someone whose room has
 * none. Nothing is better than a wrong number, and the gap is one beat.
 */

let current = $state<BudgetReadout | null>(null);
let resets = $state<string | null>(null);

export const roomBudget = {
	get readout(): BudgetReadout | null {
		return current;
	},

	/** When the budget next returns to zero, ISO, for the copy that explains it. */
	get resetsAt(): string | null {
		return resets;
	},

	/**
	 * Publish a reading from a heartbeat response.
	 *
	 * Takes the raw seconds rather than a formatted readout so the phrasing and
	 * the warning threshold stay in `model/ledger.ts` where they are unit-tested
	 * — this module holds the value, it does not decide what it means. The reset
	 * timestamp stays an ISO string for the same reason: formatting it needs the
	 * viewer's locale and time zone, which is a component's business.
	 */
	report(usedSeconds: number, capSeconds: number, resetsAt: string): void {
		current = budgetReadout(usedSeconds, capSeconds);
		resets = resetsAt;
	},

	/**
	 * Forget the current reading.
	 *
	 * Called when leaving a room: the next room's budget is a different room's,
	 * and carrying this one across would show the wrong number for one beat.
	 * Renaming NAVIGATES (UX-ROOM-10), so this is reachable in normal use.
	 */
	clear(): void {
		current = null;
		resets = null;
	}
};
