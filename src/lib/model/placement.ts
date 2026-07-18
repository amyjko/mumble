import type { Point, RoomState } from './types';

/**
 * Remembered placement (AR-CTRL-4 / AR-CTRL-6), as pure functions over room
 * state so both the store and the canvas read the SAME rule.
 *
 * This module exists because the key format was briefly written out in two
 * places — the store that writes the map and the component that reads it. A
 * key format duplicated as a template literal is a silent-drift bug waiting
 * to happen: change one and nothing fails, you simply stop finding anything,
 * which reads as "no memory" rather than as a defect.
 */

/**
 * Memory is per (participant, configuration) — AR-CTRL-6's triple minus
 * room_id, which the store already scopes. `'none'` stands in for the
 * unconfigured room so it is a key like any other rather than a special case.
 */
export function locationKey(participantId: string, activeConfig: string | null): string {
	return `${participantId}:${activeConfig ?? 'none'}`;
}

/** The remembered spot for someone in the currently active configuration. */
export function rememberedLocation(state: RoomState, participantId: string): Point | undefined {
	return state.participant_locations[locationKey(participantId, state.active_config)];
}

/**
 * Whether the room placed someone somewhere OTHER than where they left off.
 *
 * True only when a remembered spot exists and entry did not honour it — i.e.
 * re-validation rejected it and AR-CTRL-4 fell through to nearest-legal. It
 * self-clears, because moving rewrites the remembered spot to match.
 *
 * The tolerance is deliberate: nearest-legal returns exact coordinates, so a
 * genuine displacement is never sub-pixel, and an exact equality check would
 * make this sensitive to float noise it has no reason to care about.
 */
export function wasDisplaced(state: RoomState, participantId: string): boolean {
	const remembered = rememberedLocation(state, participantId);
	const here = state.participants[participantId]?.location;
	if (remembered === undefined || here === undefined) return false;
	return Math.hypot(remembered.x - here.x, remembered.y - here.y) > 1;
}
