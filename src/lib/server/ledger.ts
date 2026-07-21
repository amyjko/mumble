import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import { beatSeconds, isExhausted } from '$lib/model/ledger';

/**
 * The control plane's side of the time meter (AR-COST-2..4, UX-ECON-2).
 *
 * Three thin wrappers over the SQL functions, which is deliberate: the
 * arithmetic that decides how much a beat is worth lives in `model/ledger.ts`
 * (pure, node-tested), the arithmetic that decides who pays lives in
 * `meter_seconds` (one statement pair, so the counter and its audit trail
 * cannot drift), and nothing here re-decides either. This module only carries
 * the values between them.
 *
 * Split from the routes so the real database interaction is testable without
 * constructing an HTTP request, the same shape `image-cleanup.ts` uses.
 */

/**
 * Credit one beat's worth of presence to the room's owner.
 *
 * Errors are swallowed, on purpose and with the same reasoning the blob cleanup
 * gives: the beat's PRIMARY job is liveness, and a room whose participants
 * cannot report that they are still present is a room whose conch never frees.
 * Failing the beat because the meter is unavailable would trade a billing
 * inaccuracy for a stuck room, which is much the worse failure. An uncounted
 * beat costs the operator fifteen seconds of somebody's time.
 */
export async function meterBeat(
	db: SupabaseClient<Database>,
	roomId: string,
	identityId: string,
	lastSeen: Date | null,
	now: Date = new Date()
): Promise<number> {
	const seconds = beatSeconds(lastSeen, now);
	if (seconds === 0) return 0;
	await db
		.rpc('meter_seconds', { p_room: roomId, p_identity: identityId, p_seconds: seconds })
		.then(
			() => undefined,
			() => undefined
		);
	return seconds;
}

/**
 * Stamp `left_at` on the open intervals of people who have gone.
 *
 * Audit trail only — it moves no seconds, because the seconds were credited
 * beat by beat as they were spent. An interval that is never closed is a crash
 * rather than a leak, and its `seconds` are already correct.
 */
export async function closeIntervals(
	db: SupabaseClient<Database>,
	roomId: string,
	identityIds: readonly string[]
): Promise<void> {
	if (identityIds.length === 0) return;
	await db
		.rpc('close_ledger_rows', { p_room: roomId, p_identities: [...identityIds] })
		.then(
			() => undefined,
			() => undefined
		);
}

/**
 * What a room has left this week — ONE read, which everything else derives from.
 *
 * The room's budget is its OWNER's account (UX-ID-4): guests hold no account, so
 * the owner's is the only one a room can draw on. That is why this is keyed on a
 * room and not on a person, even though it returns an account's numbers.
 *
 * Rolls before reading (AR-COST-6): the weekly reset is lazy, so a budget that
 * expired at the week boundary is only actually reset by somebody reading it.
 * Reading these columns raw would show last week's total and refuse a join
 * against it — a cap that never lets go. Nothing anywhere reads them without
 * rolling first, which is the property this function exists to hold.
 *
 * Returns null when it cannot be read at all, and every caller treats that as
 * "do not stand in anyone's way" — see `roomHasTime`.
 */
export interface RoomBudget {
	usedSeconds: number;
	capSeconds: number;
	/** ISO timestamp: when the counter next returns to zero. */
	resetsAt: string;
}

export async function roomBudget(
	db: SupabaseClient<Database>,
	roomId: string
): Promise<RoomBudget | null> {
	const room = await db.from('rooms').select('owner_id').eq('id', roomId).maybeSingle();
	if (room.data === null) return null;

	// No `.maybeSingle()`: `roll_account` returns accounts%rowtype, so the RPC
	// already yields one row rather than a set. Asking for single on top of that
	// asks PostgREST to unwrap something that was never wrapped.
	const account = await db.rpc('roll_account', { p_account: room.data.owner_id });
	if (account.error !== null) return null;

	return {
		usedSeconds: account.data.weekly_seconds_used,
		capSeconds: account.data.weekly_cap_seconds,
		resetsAt: account.data.week_resets_at
	};
}

/**
 * May anyone else enter this room this week? (AR-COST-4)
 *
 * The gate, in one place, read by three callers — the mutation route that
 * decides it, the admission route that must not wave someone past it, and the
 * page load that explains it. It is also the same read the toolbar's readout
 * renders, which is the point of routing both through `roomBudget`: a second
 * copy of "is there time left" is how a gate and the screen describing it come
 * to disagree, and here they would disagree about a number people are watching.
 *
 * Fails OPEN. If the ledger cannot be read, people get into their meeting. The
 * failure this protects against is a free product being farmed, which is slow
 * and recoverable; the failure it would cause by closing is everybody locked out
 * of every room at once, which is neither.
 */
export async function roomHasTime(
	db: SupabaseClient<Database>,
	roomId: string
): Promise<boolean> {
	const budget = await roomBudget(db, roomId);
	if (budget === null) return true;
	return !isExhausted(budget.usedSeconds, budget.capSeconds);
}

/**
 * When the room's budget next resets, for the copy that has to say so.
 *
 * A date rather than "later this week" because `week_resets_at` makes a real
 * one available, and a refusal that cannot say when it lifts reads as a fault
 * rather than a limit.
 */
export async function roomBudgetResetsAt(
	db: SupabaseClient<Database>,
	roomId: string
): Promise<string | null> {
	return (await roomBudget(db, roomId))?.resetsAt ?? null;
}
