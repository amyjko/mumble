import { describe, expect, it } from 'vitest';
import { diffRoomState } from './diff';
import { applyMutation } from './rules';
import { roomStateSchema } from './schemas';
import { newNote } from './create';
import { newParticipant } from './avatar';
import { encodedFromText } from './ydoc';
import type { RoomState } from './types';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

function room(): RoomState {
	return roomStateSchema.parse({ objects: {}, participants: {} });
}

/** The engine mutates in place, so a diff needs a snapshot taken beforehand. */
function snapshot(state: RoomState): RoomState {
	return roomStateSchema.parse(JSON.parse(JSON.stringify(state)));
}

const ctx = { actorId: ALICE, isHost: true };

describe('diffRoomState (AR-BACKEND-4)', () => {
	it('reports nothing when nothing changed', () => {
		const state = room();
		const diff = diffRoomState(snapshot(state), state);
		expect(diff.empty).toBe(true);
		expect(diff.room).toBeNull();
	});

	it('THE property: editing one object leaves the others untouched', () => {
		// This is the fix. The whole-room write held a database connection while
		// rewriting every row for every keystroke, which exhausted PostgREST's
		// pool almost immediately. If this assertion ever regresses, that
		// returns — and it returns as "the app is broken", not as a slow query.
		const state = room();
		for (let i = 0; i < 20; i++) {
			applyMutation(state, { kind: 'create_object', object: newNote(ALICE, { x: i * 400, y: 0 }, i) }, ctx);
		}
		const before = snapshot(state);

		const target = Object.values(state.objects)[3];
		expect(target).toBeDefined();
		if (target === undefined) return;
		applyMutation(
			state,
			// Far clear of the row of notes: an overlapping move is REJECTED
			// (UX-OBJ-12), which would make this test about the solver instead.
			{ kind: 'move_object', id: target.id, transform: { ...target.transform, y: 4000 } },
			ctx
		);

		const diff = diffRoomState(before, state);
		expect(diff.objects.upsert).toHaveLength(1);
		expect(diff.objects.upsert[0]?.id).toBe(target.id);
		expect(diff.objects.remove).toEqual([]);
		// And the room row is not touched either, since no scalar moved.
		expect(diff.room).toBeNull();
	});

	it('carries a deletion as an absence, which an upsert cannot express', () => {
		const state = room();
		const note = newNote(ALICE, { x: 0, y: 0 }, 1);
		applyMutation(state, { kind: 'create_object', object: note }, ctx);
		const before = snapshot(state);

		applyMutation(state, { kind: 'delete_object', id: note.id }, ctx);

		const diff = diffRoomState(before, state);
		expect(diff.objects.remove).toEqual([note.id]);
		expect(diff.objects.upsert).toEqual([]);
	});

	it('separates a scalar change from the collections', () => {
		const state = room();
		applyMutation(state, { kind: 'create_object', object: newNote(ALICE, { x: 0, y: 0 }, 1) }, ctx);
		const before = snapshot(state);

		applyMutation(state, { kind: 'set_room_meta', title: 'Standup', description: '' }, ctx);

		const diff = diffRoomState(before, state);
		expect(diff.room?.title).toBe('Standup');
		// The object did not change, so it is not rewritten.
		expect(diff.objects.upsert).toEqual([]);
	});

	it('tracks participants joining and leaving', () => {
		const state = room();
		applyMutation(state, { kind: 'upsert_participant', participant: newParticipant({ id: ALICE, name: 'Ada', emoji: '🐢' }) }, ctx);
		const before = snapshot(state);

		applyMutation(state, { kind: 'upsert_participant', participant: newParticipant({ id: BOB, name: 'Bob', emoji: '🦊' }) }, ctx);
		const joined = diffRoomState(before, state);
		expect(joined.participants.upsert.map((p) => p.id)).toEqual([BOB]);

		const mid = snapshot(state);
		applyMutation(state, { kind: 'remove_participant', id: BOB }, ctx);
		expect(diffRoomState(mid, state).participants.remove).toEqual([BOB]);
	});

	it('notices a remembered location, which is keyed rather than id-bearing', () => {
		// participant_locations is keyed by (participant, configuration) and the
		// value carries no id, so the key has to be carried alongside it.
		const state = room();
		applyMutation(state, { kind: 'upsert_participant', participant: newParticipant({ id: ALICE, name: 'Ada', emoji: '🐢' }) }, ctx);
		const before = snapshot(state);

		applyMutation(state, { kind: 'move_participant', id: ALICE, location: { x: 240, y: 160 } }, ctx);

		const diff = diffRoomState(before, state);
		expect(diff.locations.upsert).toHaveLength(1);
		expect(diff.locations.upsert[0]?.point).toEqual({ x: 240, y: 160 });
		expect(diff.locations.upsert[0]?.key).toContain(ALICE);
	});

	it('a note edit rewrites ONE row, however long the document gets', () => {
		// edit_note is the highest-frequency mutation, and the one that made the
		// old write path untenable: every keystroke rewrote every object row.
		const state = room();
		const note = newNote(ALICE, { x: 0, y: 0 }, 1);
		applyMutation(state, { kind: 'create_object', object: note }, ctx);
		applyMutation(state, { kind: 'create_object', object: newNote(ALICE, { x: 400, y: 0 }, 2) }, ctx);
		const before = snapshot(state);

		// A real Yjs update, not the document itself: `edit_note` applies an
		// UPDATE, and passing a whole doc is rejected as malformed.
		applyMutation(state, { kind: 'edit_note', id: note.id, update: encodedFromText('hello') }, ctx);

		const diff = diffRoomState(before, state);
		expect(diff.objects.upsert.length).toBeLessThanOrEqual(1);
	});
});
