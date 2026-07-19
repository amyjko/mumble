import type { RoomStateDiff } from '$lib/model/diff';

/**
 * Whether a write must not land second (AR-BACKEND-4).
 *
 * Guarding everything is not merely slow, it is LOSSY: measured, twenty
 * concurrent writers touching twenty DIFFERENT objects lost seventeen of their
 * writes to an exhausted retry budget, because one room-wide counter makes
 * every writer invalidate every other. So the guard is applied where landing
 * second can actually break something.
 *
 * The first version of this reasoned that everything outside `diff.room` writes
 * disjoint rows "where last-writer-wins is correct rather than a compromise".
 * That is true of the WRITES and false of the DECISIONS, which is the part that
 * matters: nine mutation kinds consult rows they do not write — `create_object`
 * and `move_object` validate against every other shape (UX-OBJ-12),
 * `upsert_participant` counts the room against `max_participants` (UX-STAGE-11)
 * and then places the arrival against everyone already there (AR-CTRL-4). Two
 * unguarded writers can each pass a check that neither would pass if it could
 * see the other.
 *
 * What is guarded, and why only this much:
 *
 *  - `diff.room !== null` — every stage, capacity, placer, layout and room-meta
 *    write. `diffRoomState` compares scalars BY VALUE, so a mutation that
 *    reassigns `video_holders` to an equal array correctly produces no guard
 *    while one that actually takes a slot does. This is what stops two people
 *    holding one slot (AR-MEDIA-1).
 *  - `COUNTING` — decisions against a HARD CAP, where landing second admits
 *    someone the cap should have refused.
 *
 * Object writes are no longer listed here at all. They carry their OWN version
 * now (`objectVersions`, see room-state.ts), so `edit_note` and `post_message`
 * — the read-modify-write pair that last-writer-wins silently truncates — are
 * guarded per object instead of room-wide. That is strictly better in both
 * directions: two people typing in two DIFFERENT notes no longer conflict at
 * all, and two people editing the SAME object now do, where before they raced
 * and the loser's edit vanished.
 *
 * Still NOT solved: overlap. Per-object versions do not help — two writers
 * moving two DIFFERENT objects into the same space each pass their own row's
 * check, because overlap is a cross-row invariant. UX-OBJ-12 records this and
 * stays PARTIAL. Serialising every geometry write against a shared token would
 * close it, at the cost the measurement above describes.
 */

/**
 * Mutations that decide against a hard cap by counting rows they do not write.
 *
 * `upsert_participant` refuses entry once the room holds `max_participants`
 * (UX-STAGE-11) and then resolves placement against everyone present
 * (AR-CTRL-4). Unguarded, two people arriving at once each counted a room
 * without the other: both were admitted past the cap, and both could be placed
 * in the same spot — which is precisely the arrival race that placement was
 * moved server-side to prevent, still open because the write was not
 * serialised. Arrivals are rare, so the retry this costs is affordable in a way
 * it would not be for dragging.
 */
const COUNTING: ReadonlySet<string> = new Set(['upsert_participant']);

export function needsGuard(diff: RoomStateDiff, kind: string): boolean {
	return diff.room !== null || COUNTING.has(kind);
}
