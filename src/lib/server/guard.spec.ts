import { describe, expect, it } from 'vitest';
import { needsGuard } from './guard';
import { diffRoomState } from '$lib/model/diff';
import { applyMutation } from '$lib/model/rules';
import { freshStage } from '$lib/model/stage';
import { DEFAULT_BORDER_WIDTH } from '$lib/model/schemas';
import { newParticipant } from '$lib/model/avatar';
import { newNote } from '$lib/model/create';
import { encodedFromText } from '$lib/model/ydoc';
import type { RoomState } from '$lib/model/types';

/**
 * Which writes get the compare-and-swap (AR-BACKEND-4).
 *
 * A pure function over a diff and a mutation kind, so it is tested with no
 * database — and tested through REAL diffs produced by the rule engine rather
 * than hand-built ones, because the whole question is what the engine's own
 * output looks like for a given mutation. A hand-built diff would let this
 * agree with itself while disagreeing with the route.
 */

const HOST = '11111111-1111-4111-8111-111111111111';
const GUEST = '22222222-2222-4222-8222-222222222222';
const ctx = { actorId: HOST, isHost: true };

/** The diff a mutation actually produces, exactly as the route computes it. */
function diffOf(state: RoomState, mutate: (s: RoomState) => void) {
	const before = structuredClone(state);
	mutate(state);
	return diffRoomState(before, state);
}

/** A fresh room, built from the same pieces the store's own empty state uses. */
function freshRoomState(): RoomState {
	return {
		objects: {},
		participants: {},
		background: '',
		title: '',
		description: '',
		create_permission: 'all',
		border_default: DEFAULT_BORDER_WIDTH,
		...freshStage(),
		transport: 'p2p',
		participant_locations: {},
		placers: [],
		configurations: {},
		active_config: null
	};
}

function roomWithHost(): RoomState {
	const state = freshRoomState();
	applyMutation(
		state,
		{ kind: 'upsert_participant', participant: newParticipant({ id: HOST, name: 'Host', emoji: '🐬' }) },
		ctx
	);
	return state;
}

describe('needsGuard', () => {
	it('guards a write that changes a room scalar', () => {
		const state = roomWithHost();
		const diff = diffOf(state, (s) =>
			applyMutation(s, { kind: 'take_slot', id: HOST, media: 'video' }, ctx)
		);
		// Two people must not hold one slot (AR-MEDIA-1).
		expect(diff.room).not.toBeNull();
		expect(needsGuard(diff, 'take_slot')).toBe(true);
	});

	it('guards an arrival, which decides against a hard cap', () => {
		// THE regression this file exists for. `upsert_participant` counts the
		// room against max_participants (UX-STAGE-11) and then places the arrival
		// against everyone present (AR-CTRL-4) — but it writes only a participant
		// row, so the earlier "is a room scalar changing?" rule left it
		// unguarded. Two people arriving at once each counted a room without the
		// other: both admitted past the cap, both placeable in one spot.
		const state = roomWithHost();
		const diff = diffOf(state, (s) =>
			applyMutation(
				s,
				{ kind: 'upsert_participant', participant: newParticipant({ id: GUEST, name: 'Guest', emoji: '🦊' }) },
				{ actorId: GUEST, isHost: false }
			)
		);
		// Proves the gap was real: an arrival changes NO room scalar, so the
		// scalar rule alone would not have guarded it.
		expect(diff.room).toBeNull();
		expect(diff.participants.upsert).toHaveLength(1);
		expect(needsGuard(diff, 'upsert_participant')).toBe(true);
	});

	it('guards a note edit, which merges into stored content', () => {
		const state = roomWithHost();
		applyMutation(state, { kind: 'create_object', object: newNote(HOST, { x: 0, y: 0 }, 1, 10) }, ctx);
		const note = Object.values(state.objects)[0];
		if (note === undefined) throw new Error('no note');
		const diff = diffOf(state, (s) =>
			// A REAL Yjs update: an empty string is refused by the rule engine,
			// so the test would have proved only that invalid input throws.
			applyMutation(s, { kind: 'edit_note', id: note.id, update: encodedFromText('hello') }, ctx)
		);
		expect(needsGuard(diff, 'edit_note')).toBe(true);
	});

	it('does NOT guard a plain object move', () => {
		// The case the narrowing exists for: disjoint rows, and the measurement
		// says guarding these goes lossy under concurrency.
		const state = roomWithHost();
		applyMutation(state, { kind: 'create_object', object: newNote(HOST, { x: 0, y: 0 }, 1, 10) }, ctx);
		const note = Object.values(state.objects)[0];
		if (note === undefined) throw new Error('no note');
		const diff = diffOf(state, (s) =>
			applyMutation(
				s,
				{ kind: 'move_object', id: note.id, transform: { ...note.transform, x: 900, y: 900 } },
				ctx
			)
		);
		expect(diff.room).toBeNull();
		expect(needsGuard(diff, 'move_object')).toBe(false);
	});

	it('does not guard a write that changed nothing on the room', () => {
		// `diffRoomState` compares scalars BY VALUE, so re-asserting an equal
		// value must not manufacture a conflict.
		const state = roomWithHost();
		const diff = diffOf(state, () => {});
		expect(needsGuard(diff, 'set_capacity')).toBe(false);
	});
});
