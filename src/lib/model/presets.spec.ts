import { describe, expect, it } from 'vitest';
import { defaultRoomState, PRESET_LAYOUT_NAMES } from './presets';
import { roomStateSchema } from './schemas';
import { shapeOfObject, shapeOfPlacer, participatesInCollision } from './shapes';
import { placementLegal } from '$lib/canvas/geometry';
import type { ConfigSnapshot, RoomState } from './types';

const OWNER = '11111111-1111-4111-8111-111111111111';

function layout(state: RoomState, name: string): ConfigSnapshot {
	const config = Object.values(state.configurations).find((c) => c.name === name);
	if (config === undefined) throw new Error(`no layout named ${name}`);
	return config.snapshot;
}

describe('a new room arrives furnished (UX-ROOM-12)', () => {
	it('is a valid room state', () => {
		// The seeding write goes through the same schema the canvas renders, so
		// an invalid preset would fail at the database rather than here.
		expect(roomStateSchema.safeParse(defaultRoomState(OWNER)).success).toBe(true);
	});

	it('carries the three layouts, gallery first and active', () => {
		const state = defaultRoomState(OWNER);
		const names = Object.values(state.configurations).map((c) => c.name);
		expect(names).toEqual(['Gallery', 'One on one', 'Featured speaker']);
		expect(names).toEqual([...PRESET_LAYOUT_NAMES]);
		expect(state.configurations[state.active_config ?? '']?.name).toBe('Gallery');
	});

	it('leaves the live state agreeing with the ACTIVE layout', () => {
		// Otherwise the room repairs itself the first time anyone hits reset,
		// which reads as the layout changing for no reason.
		const state = defaultRoomState(OWNER);
		const active = layout(state, 'Gallery');
		expect(state.placers).toEqual(active.placers);
		expect(state.capacity).toEqual(active.capacity);
		for (const [id, pose] of Object.entries(active.poses)) {
			expect(state.objects[id]?.transform).toEqual(pose.transform);
			expect(state.objects[id]?.hidden).toBe(pose.hidden);
		}
	});
});

describe('each layout states its spots AND its capacity (UX-STAGE-1)', () => {
	// Placement is a coordinate and capacity is a number: a layout that laid
	// out five spots but left max_av at the room default would show five
	// placeholders and admit four cameras.
	const expected = [
		{ name: 'Gallery', placers: 5, max_av: 5, max_audio: 8, max_participants: 20 },
		{ name: 'One on one', placers: 2, max_av: 2, max_audio: 2, max_participants: 8 },
		{ name: 'Featured speaker', placers: 36, max_av: 1, max_audio: 35, max_participants: 36 }
	];

	for (const want of expected) {
		it(`${want.name}: ${String(want.placers)} spots, max_av ${String(want.max_av)}`, () => {
			const snapshot = layout(defaultRoomState(OWNER), want.name);
			expect(snapshot.placers).toHaveLength(want.placers);
			expect(snapshot.capacity).toEqual({
				max_participants: want.max_participants,
				max_av: want.max_av,
				max_audio: want.max_audio
			});
		});
	}

	it('never promises more publishers than the room holds', () => {
		const state = defaultRoomState(OWNER);
		for (const config of Object.values(state.configurations)) {
			const { max_participants, max_av, max_audio } = config.snapshot.capacity;
			expect(max_av).toBeLessThanOrEqual(max_participants);
			expect(max_audio).toBeLessThanOrEqual(max_participants);
		}
	});

	it('gives the featured speaker an audience that can be HEARD', () => {
		// The point of that layout: 35 people who may speak but not send video.
		const snapshot = layout(defaultRoomState(OWNER), 'Featured speaker');
		expect(snapshot.capacity.max_audio).toBe(snapshot.placers.length - 1);
	});
});

describe('the geometry is legal, by the real solver', () => {
	// These placers are written straight into state rather than through
	// add_placer, so nothing resolved their overlap for them. Arithmetic in a
	// preset file is exactly the kind of thing that is wrong by 8 world units
	// and nobody notices until two arrivals land on top of each other.
	const state = defaultRoomState(OWNER);

	for (const config of Object.values(state.configurations)) {
		const { placers, poses } = config.snapshot;

		it(`${config.name}: no two spots overlap`, () => {
			const shapes = placers.map(shapeOfPlacer);
			for (const [i, shape] of shapes.entries()) {
				const others = shapes.filter((_, j) => j !== i);
				expect(placementLegal(shape, others), `spot ${String(i + 1)}`).toBe(true);
			}
		});

		it(`${config.name}: no spot sits under visible content`, () => {
			// A hidden object holds no space (UX-ROOM-3), and neither does a
			// drawing — the same two exemptions the rule engine applies.
			const content = Object.entries(poses).flatMap(([id, pose]) => {
				const object = state.objects[id];
				if (object === undefined) throw new Error('posed object does not exist');
				if (pose.hidden || !participatesInCollision(object)) return [];
				return [shapeOfObject({ ...object, transform: pose.transform })];
			});
			for (const [i, placer] of placers.entries()) {
				expect(placementLegal(shapeOfPlacer(placer), content), `spot ${String(i + 1)}`).toBe(true);
			}
		});
	}
});

describe('objects exist in every layout (UX-ROOM-3)', () => {
	const state = defaultRoomState(OWNER);

	it('poses every object in every configuration', () => {
		const ids = Object.keys(state.objects).sort();
		expect(ids).toHaveLength(2);
		for (const config of Object.values(state.configurations)) {
			expect(Object.keys(config.snapshot.poses).sort()).toEqual(ids);
		}
	});

	it('shows the chat where a crowd is and the note where two people are', () => {
		const visible = (name: string): string[] =>
			Object.entries(layout(state, name).poses)
				.filter(([, pose]) => !pose.hidden)
				.map(([id]) => state.objects[id]?.type ?? '');
		expect(visible('Gallery')).toEqual(['chat']);
		expect(visible('One on one')).toEqual(['note']);
		expect(visible('Featured speaker')).toEqual(['chat']);
	});
});
