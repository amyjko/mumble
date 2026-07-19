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
 *  - `MERGING` — read-modify-write into existing row content, which
 *    last-writer-wins silently truncates.
 *  - `COUNTING` — decisions against a HARD CAP, where landing second admits
 *    someone the cap should have refused.
 *
 * Deliberately NOT guarded: the overlap checks in `move_object`,
 * `create_object`, `set_border`, `set_hidden`, `move_participant` and
 * `size_participant`. Two concurrent writers can produce an overlap that
 * neither would have accepted alone — a real UX-OBJ-12 violation, and it is
 * recorded as one rather than hidden here. It is visible, recoverable by
 * dragging, and no worse than the stub's behaviour, whereas guarding the
 * high-frequency canvas mutations is the case the measurement above says goes
 * lossy. The durable fix is per-object versions (a conflict then means
 * "someone edited THIS object", which is a fact worth surfacing) rather than a
 * wider room-wide guard.
 */

/**
 * Mutations that MERGE into content already in the row rather than replacing
 * it. `edit_note` applies a Yjs update to the stored document and
 * `post_message` appends to a log; both lose content under last-writer-wins,
 * and neither shows up in `diff.room`, so neither can be inferred from the diff.
 *
 * `edit_timer` is deliberately absent: it replaces the payload wholesale, so
 * the last writer is the correct winner.
 */
const MERGING: ReadonlySet<string> = new Set(['edit_note', 'post_message']);

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
	return diff.room !== null || MERGING.has(kind) || COUNTING.has(kind);
}
