/**
 * Room name rules (UX-ROOM-9), in one place.
 *
 * The pattern used to be written out twice — once on the landing form and once
 * in the route's load — with each caller separately remembering to lowercase
 * the result. Two copies of a validation rule is one copy too many; a third
 * call site would have been the one that forgot.
 *
 * Pure and node-tested. The uniqueness half of UX-ROOM-9 ("cannot both exist")
 * is a database constraint (AR-BACKEND-10) and cannot be decided here.
 */

/** Lowercase letters, digits, `-` and `_`; length 2–32. */
const PATTERN = /^[a-z0-9_-]{2,32}$/;

/**
 * Names that may not be claimed.
 *
 * UX-ROOM-9 notes this list only has to cover names used directly under
 * `/hey/` — because rooms live under that prefix, no room name can ever
 * collide with a top-level route like `/login` or `/api`. That containment is
 * the whole reason to keep the prefix, so the list stays genuinely small:
 * words we may want under /hey/ later, plus a few that would be actively
 * confusing to hand out.
 */
export const RESERVED_NAMES: readonly string[] = [
	'new',
	'admin',
	'api',
	'about',
	'help',
	'support',
	'settings',
	'login',
	'logout',
	'signup',
	'account',
	'me',
	'you',
	'null',
	'undefined'
];

/**
 * The canonical form of a name: trimmed and lowercased.
 *
 * UX-ROOM-9 compares case-insensitively, so `LCI` and `lci` are the same room.
 * Canonicalizing in one function means callers cannot forget — which they
 * previously could, since each did its own `.toLowerCase()`.
 */
export function canonicalRoomName(input: string): string {
	return input.trim().toLowerCase();
}

export type RoomNameProblem = 'shape' | 'reserved';

/** Why this name is unusable, or null when it is fine. Canonicalizes first. */
export function roomNameProblem(input: string): RoomNameProblem | null {
	const name = canonicalRoomName(input);
	if (!PATTERN.test(name)) return 'shape';
	if (RESERVED_NAMES.includes(name)) return 'reserved';
	return null;
}

export function isValidRoomName(input: string): boolean {
	return roomNameProblem(input) === null;
}

/** A message suitable for showing next to an input. */
export function roomNameMessage(problem: RoomNameProblem): string {
	return problem === 'reserved'
		? 'That name is reserved — pick another.'
		: 'Use 2–32 letters, digits, dashes or underscores.';
}
