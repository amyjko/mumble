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
 * This list used to be short, and said so: rooms lived under `/hey/`, so a room
 * name could not collide with a top-level route however hard it tried, and the
 * list only had to cover names we might want under the prefix itself. Rooms
 * moved to the root on 2026-07-21 (UX-ROOM-9), which inverts the argument
 * exactly. Nothing separates a room name from a route name any more, so the
 * list is deliberately OVER-broad — reserving a word costs one name nobody has
 * asked for, while failing to reserve one costs a route we cannot ship without
 * evicting someone from an address they have been reading aloud for a year.
 *
 * Routing itself does not depend on this: SvelteKit sorts static segments ahead
 * of dynamic ones, so `/login` beats `/[room]` whether or not `login` is here.
 * What the list buys is the FUTURE route — the one that does not exist yet, and
 * so cannot win anything.
 *
 * Grouped by why each name is spoken for; the SQL mirror in
 * supabase/migrations/20260721000001_reserve_root_names.sql keeps the same
 * grouping, and a test proves the two agree.
 */
export const RESERVED_NAMES: readonly string[] = [
	// Live routes and their obvious aliases.
	'account',
	'api',
	'auth',
	'login',
	'logout',
	'new',
	'oauth',
	'signin',
	'signout',
	'signup',
	// Served from static/ or by convention, before any route is consulted.
	'assets',
	'cdn',
	'favicon',
	'fonts',
	'img',
	'robots',
	'rss',
	'static',
	'well-known',
	// The marketing and support surface a product this age grows next.
	'about',
	'blog',
	'careers',
	'changelog',
	'contact',
	'demo',
	'desktop',
	'docs',
	'download',
	'enterprise',
	'faq',
	'feed',
	'help',
	'home',
	'news',
	'pricing',
	'security',
	'status',
	'support',
	'team',
	// Money and account management (UX-ECON).
	'billing',
	'dashboard',
	'pro',
	'settings',
	'upgrade',
	// Legal.
	'cookies',
	'legal',
	'privacy',
	'terms',
	// The product's own vocabulary — DESIGN.md's nouns, which would read as
	// documentation rather than as somebody's standup.
	'house',
	'houses',
	'mumble',
	'room',
	'rooms',
	'studio',
	// The address scheme rooms used to live under; a room AT /hey would be a
	// confusing echo of the prefix this change retired.
	'hey',
	// Anything that would be actively confusing, ambiguous, or a footgun to
	// hand out as an address.
	'admin',
	'embed',
	'explore',
	'invite',
	'join',
	'me',
	'profile',
	'public',
	'search',
	'user',
	'users',
	'ws',
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
