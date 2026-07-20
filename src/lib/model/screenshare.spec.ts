import { describe, expect, it } from 'vitest';
import { applyMutation } from './rules';
import { roomStateSchema } from './schemas';
import { newScreenshare, newNote } from './create';
import { newParticipant } from './avatar';
import { StoreRejection } from './types';
import type { RoomState } from './types';

/**
 * Starting and stopping a screen share (UX-OBJ-6).
 *
 * The rule engine is the only place the two halves of a share — a slot from the
 * `max_av` pool and an object on the canvas — are held together. Everything
 * here is about that pairing: neither half may exist without the other, by any
 * route, including the ones nobody thought to write a mutation for.
 *
 * Node-only. `applyMutation` is the same function the server runs (AR-SYNC-3),
 * so what passes here is what the server enforces.
 */

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';

const at = { x: 0, y: 0 };

function room(over: Partial<RoomState> = {}): RoomState {
	const state = roomStateSchema.parse({
		objects: {},
		participants: {},
		capacity: { max_participants: 10, max_av: 2, max_audio: 2 },
		...over
	});
	for (const id of [ALICE, BOB, CAROL]) {
		state.participants[id] = newParticipant({ id, name: id.slice(0, 4), emoji: '🐢' });
	}
	return state;
}

const asAlice = { actorId: ALICE, isHost: false };
const asBob = { actorId: BOB, isHost: false };
const asHost = { actorId: CAROL, isHost: true };

/** Every screenshare object currently on the canvas, by owner. */
function shares(state: RoomState): string[] {
	const owners: string[] = [];
	for (const object of Object.values(state.objects)) {
		if (object.type !== 'screenshare') continue;
		owners.push(object.payload.owner_id);
	}
	return owners;
}

function start(state: RoomState, who: string, ctx = { actorId: who, isHost: false }): void {
	applyMutation(state, { kind: 'start_screenshare', id: who, object: newScreenshare(who, at, 0) }, ctx);
}

describe('starting a share is atomic', () => {
	it('takes the slot and creates the object together', () => {
		const state = room();
		start(state, ALICE);
		expect(state.screen_holders).toEqual([ALICE]);
		expect(shares(state)).toEqual([ALICE]);
	});

	it('creates NO object when the pool is full', () => {
		/*
		 * The failure this rules out is a phantom tile: an object on the canvas
		 * whose owner holds no slot, so every peer subscribes to a track that will
		 * never arrive and nobody can work out why it is blank.
		 */
		const state = room({ video_holders: [ALICE, BOB] });
		expect(() => {
			start(state, CAROL);
		}).toThrow(StoreRejection);
		expect(state.screen_holders).toEqual([]);
		expect(shares(state)).toEqual([]);
	});

	it('is refused for somebody else', () => {
		const state = room();
		expect(() =>
			applyMutation(
				state,
				{ kind: 'start_screenshare', id: ALICE, object: newScreenshare(ALICE, at, 0) },
				asBob
			)
		).toThrow(StoreRejection);
		expect(shares(state)).toEqual([]);
	});

	it('is refused when the object names an owner other than the sharer', () => {
		// Otherwise Alice starts a "share" that routes Bob's screen — or nobody's.
		const state = room();
		expect(() =>
			applyMutation(
				state,
				{ kind: 'start_screenshare', id: ALICE, object: newScreenshare(BOB, at, 0) },
				asAlice
			)
		).toThrow(StoreRejection);
		expect(state.screen_holders).toEqual([]);
	});

	it('respects the room create permission (UX-OBJ-9)', () => {
		// A room where members may not create objects is a room where they may not
		// put a screen on the canvas either.
		const state = room({ create_permission: 'host' });
		expect(() => {
			start(state, ALICE);
		}).toThrow(StoreRejection);
		expect(state.screen_holders).toEqual([]);
	});

	it('costs the pool two when the same person is also on camera', () => {
		const state = room({ video_holders: [ALICE] });
		start(state, ALICE);
		expect(state.screen_holders).toEqual([ALICE]);
		// max_av is 2 and Alice now holds both, so Bob cannot take the camera.
		applyMutation(state, { kind: 'take_slot', id: BOB, media: 'video' }, asBob);
		expect(state.video_holders).toEqual([ALICE]);
		expect(state.queue).toEqual([BOB]);
	});
});

describe('a share never outlives its slot', () => {
	it('stopping releases the slot and deletes the object', () => {
		const state = room();
		start(state, ALICE);
		applyMutation(state, { kind: 'stop_screenshare', id: ALICE }, asAlice);
		expect(state.screen_holders).toEqual([]);
		expect(shares(state)).toEqual([]);
	});

	it('a host may stop somebody else’s share', () => {
		const state = room();
		start(state, ALICE);
		applyMutation(state, { kind: 'stop_screenshare', id: ALICE }, asHost);
		expect(shares(state)).toEqual([]);
	});

	it('an ordinary member may not stop somebody else’s share', () => {
		const state = room();
		start(state, ALICE);
		expect(() => applyMutation(state, { kind: 'stop_screenshare', id: ALICE }, asBob)).toThrow(
			StoreRejection
		);
		expect(shares(state)).toEqual([ALICE]);
	});

	it('leaving the room ends the share', () => {
		const state = room();
		start(state, ALICE);
		applyMutation(state, { kind: 'remove_participant', id: ALICE }, asAlice);
		expect(state.screen_holders).toEqual([]);
		expect(shares(state)).toEqual([]);
	});

	it('a host revoking the slot deletes the object', () => {
		// Via `revoke_slot` rather than `stop_screenshare`: the invariant has to
		// hold on every route to a stage change, not just the obvious one.
		const state = room();
		start(state, ALICE);
		applyMutation(state, { kind: 'revoke_slot', id: ALICE, media: 'screen' }, asHost);
		expect(shares(state)).toEqual([]);
	});

	it('lowering max_av deletes the shares it displaces', () => {
		const state = room();
		start(state, ALICE);
		start(state, BOB);
		expect(shares(state).sort()).toEqual([ALICE, BOB].sort());

		applyMutation(
			state,
			{ kind: 'set_capacity', capacity: { max_participants: 10, max_av: 1, max_audio: 2 } },
			asHost
		);
		expect(state.screen_holders).toEqual([ALICE]);
		expect(shares(state)).toEqual([ALICE]);
	});

	it('releasing the slot directly also deletes the object', () => {
		// `release_slot` is a separate verb from `stop_screenshare` and reachable
		// by anything that can POST a mutation.
		const state = room();
		start(state, ALICE);
		applyMutation(state, { kind: 'release_slot', id: ALICE, media: 'screen' }, asAlice);
		expect(shares(state)).toEqual([]);
	});
});

describe('a slot never outlives its object', () => {
	it('deleting the object releases the slot', () => {
		const state = room();
		start(state, ALICE);
		const share = Object.values(state.objects).find((object) => object.type === 'screenshare');
		expect(share).toBeDefined();
		applyMutation(state, { kind: 'delete_object', id: share?.id ?? '' }, asAlice);
		// Otherwise the slot is stranded: capacity consumed by a tile that is gone.
		expect(state.screen_holders).toEqual([]);
	});

	it('somebody with edit permission may delete a share, ending it', () => {
		// Deliberate: a share is CONTENT (UX-PERM-1), not self-expression, so the
		// object's own permission governs. Objects are born 'all'.
		const state = room();
		start(state, ALICE);
		const share = Object.values(state.objects).find((object) => object.type === 'screenshare');
		applyMutation(state, { kind: 'delete_object', id: share?.id ?? '' }, asBob);
		expect(state.screen_holders).toEqual([]);
		expect(shares(state)).toEqual([]);
	});
});

describe('a share cannot be forged', () => {
	it('create_object refuses a screenshare outright', () => {
		/*
		 * Left open, this is the whole feature's back door: anyone could put a
		 * share object on the canvas naming anyone at all as owner, and every peer
		 * would subscribe to a track that does not exist.
		 */
		const state = room();
		expect(() =>
			applyMutation(state, { kind: 'create_object', object: newScreenshare(BOB, at, 0) }, asAlice)
		).toThrow(StoreRejection);
		expect(shares(state)).toEqual([]);
		expect(state.screen_holders).toEqual([]);
	});

	it('still allows ordinary objects through the same door', () => {
		// Guarding against a refusal that is too broad.
		const state = room();
		applyMutation(state, { kind: 'create_object', object: newNote(ALICE, at, 0) }, asAlice);
		expect(Object.values(state.objects)).toHaveLength(1);
	});
});
