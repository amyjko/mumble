import { describe, expect, it } from 'vitest';
import { locationKey, rememberedLocation, wasDisplaced } from './placement';
import type { RoomState } from './types';
import { roomStateSchema } from './schemas';

const P = '11111111-1111-4111-8111-111111111111';

function room(over: Partial<RoomState> = {}): RoomState {
	// objects/participants have no defaults; everything else does, which is what
	// keeps this fixture from restating the whole of room state.
	return { ...roomStateSchema.parse({ objects: {}, participants: {} }), ...over };
}

function withParticipant(location: { x: number; y: number }, over: Partial<RoomState> = {}): RoomState {
	return room({
		participants: {
			[P]: {
				id: P,
				name: 'Ada',
				emoji: '🐢',
				location,
				size: { width: 96, height: 96 },
				rotation: 0,
				clip: { shape: 'circle' },
				fake: false,
				away: false,
				muted: true
			}
		},
		...over
	});
}

describe('the memory key is per (participant, configuration) — AR-CTRL-6', () => {
	it('separates configurations, and names the unconfigured room explicitly', () => {
		expect(locationKey(P, 'standup')).not.toBe(locationKey(P, 'retro'));
		// 'none' is a key like any other rather than a branch elsewhere.
		expect(locationKey(P, null)).toBe(`${P}:none`);
	});

	it('reads back only the ACTIVE configuration', () => {
		const state = room({
			active_config: 'standup',
			participant_locations: {
				[locationKey(P, 'standup')]: { x: 10, y: 10 },
				[locationKey(P, 'retro')]: { x: 900, y: 900 }
			}
		});
		expect(rememberedLocation(state, P)).toEqual({ x: 10, y: 10 });
	});
});

describe('displacement is legible (AR-CTRL-4)', () => {
	it('is false when entry honoured the remembered spot', () => {
		const state = withParticipant({ x: 40, y: 40 }, {
			participant_locations: { [locationKey(P, null)]: { x: 40, y: 40 } }
		});
		expect(wasDisplaced(state, P)).toBe(false);
	});

	it('is true when re-validation moved someone elsewhere', () => {
		const state = withParticipant({ x: 400, y: 40 }, {
			participant_locations: { [locationKey(P, null)]: { x: 40, y: 40 } }
		});
		expect(wasDisplaced(state, P)).toBe(true);
	});

	it('is false on a FIRST visit, when there is nothing to have been moved from', () => {
		// The distinction that matters: arriving at the drop-in point is not
		// displacement, and announcing it would be noise on every first join.
		expect(wasDisplaced(withParticipant({ x: 0, y: 0 }), P)).toBe(false);
	});

	it('ignores sub-pixel drift', () => {
		const state = withParticipant({ x: 40.4, y: 40 }, {
			participant_locations: { [locationKey(P, null)]: { x: 40, y: 40 } }
		});
		expect(wasDisplaced(state, P)).toBe(false);
	});

	it('is false for someone who is not in the room', () => {
		expect(wasDisplaced(room(), 'absent')).toBe(false);
	});
});
