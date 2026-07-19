import type {
	CanvasObject,
	Configuration,
	Participant,
	Point,
	RoomState
} from './types';

/**
 * What changed between two room states (AR-BACKEND-4).
 *
 * The switchover to the Supabase store was blocked on this. `save_room_state`
 * wrote the ENTIRE room on every mutation — every object, participant and
 * configuration, one transaction per keystroke — holding a database connection
 * for each. PostgREST's pool saturated almost immediately, and every request
 * after that failed with "Timed out acquiring connection from connection pool",
 * which reads exactly like broken application code and is not.
 *
 * Raising the pool would have hidden that locally and reproduced it in
 * production, where the real cost is O(room) writes per keystroke. Writing only
 * what changed is the actual fix, and it is a pure function over two values the
 * route already holds — so it is tested here with no database at all.
 */

/** Room-scalar fields: everything on the room that is not a collection. */
export interface RoomScalars {
	background: string;
	title: string;
	description: string;
	create_permission: RoomState['create_permission'];
	admission: RoomState['admission'];
	border_default: number;
	capacity: RoomState['capacity'];
	video_holders: readonly string[];
	audio_holders: readonly string[];
	queue: readonly string[];
	transport: RoomState['transport'];
	placers: RoomState['placers'];
	active_config: string | null;
}

export interface Changes<T> {
	upsert: T[];
	remove: string[];
}

export interface RoomStateDiff {
	/** Null when no scalar changed, so the room row is not touched at all. */
	room: RoomScalars | null;
	objects: Changes<CanvasObject>;
	participants: Changes<Participant>;
	configurations: Changes<Configuration>;
	locations: Changes<{ key: string; point: Point }>;
	/** True when nothing changed — the caller can skip the write entirely. */
	empty: boolean;
}

/**
 * Structural equality, order-insensitive.
 *
 * The first version compared `JSON.stringify` output, on the reasoning that
 * both sides come from one construction site so key order would agree. A test
 * disproved that immediately: taking the snapshot through `roomStateSchema`
 * emits keys in SCHEMA order while the live object carries construction order,
 * so every object compared unequal and the diff degenerated to "everything
 * changed" — the exact whole-room write this function exists to eliminate,
 * reintroduced silently.
 *
 * So: a real recursive compare. It costs nothing at room scale, and it does not
 * care how the caller made its snapshot, which is one less thing for the next
 * person to get right.
 */
function same(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, i) => same(item, b[i]));
	}

	const left: Record<string, unknown> = { ...a };
	const right: Record<string, unknown> = { ...b };
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => key in right && same(left[key], right[key]));
}

function scalars(state: RoomState): RoomScalars {
	return {
		background: state.background,
		title: state.title,
		description: state.description,
		create_permission: state.create_permission,
		admission: state.admission,
		border_default: state.border_default,
		capacity: state.capacity,
		video_holders: state.video_holders,
		audio_holders: state.audio_holders,
		queue: state.queue,
		transport: state.transport,
		placers: state.placers,
		active_config: state.active_config
	};
}

function diffCollection<T>(
	before: Record<string, T>,
	after: Record<string, T>
): Changes<T> {
	const upsert: T[] = [];
	for (const [id, value] of Object.entries(after)) {
		const previous = before[id];
		// Unchanged rows are not rewritten. This is the whole point: a keystroke
		// in one note must not rewrite the other twenty objects.
		if (previous !== undefined && same(previous, value)) continue;
		upsert.push(value);
	}
	const remove = Object.keys(before).filter((id) => !(id in after));
	return { upsert, remove };
}

export function diffRoomState(before: RoomState, after: RoomState): RoomStateDiff {
	const beforeScalars = scalars(before);
	const afterScalars = scalars(after);
	const room = same(beforeScalars, afterScalars) ? null : afterScalars;

	const objects = diffCollection(before.objects, after.objects);
	const participants = diffCollection(before.participants, after.participants);
	const configurations = diffCollection(before.configurations, after.configurations);

	const locationChanges = diffCollection(before.participant_locations, after.participant_locations);
	const locations: Changes<{ key: string; point: Point }> = {
		// Locations are keyed by (participant, configuration) rather than by an
		// id inside the value, so the key has to be carried alongside it.
		upsert: Object.entries(after.participant_locations)
			.filter(([key, point]) => {
				const previous = before.participant_locations[key];
				return previous === undefined || !same(previous, point);
			})
			.map(([key, point]) => ({ key, point })),
		remove: locationChanges.remove
	};

	const empty =
		room === null &&
		objects.upsert.length === 0 &&
		objects.remove.length === 0 &&
		participants.upsert.length === 0 &&
		participants.remove.length === 0 &&
		configurations.upsert.length === 0 &&
		configurations.remove.length === 0 &&
		locations.upsert.length === 0 &&
		locations.remove.length === 0;

	return { room, objects, participants, configurations, locations, empty };
}
