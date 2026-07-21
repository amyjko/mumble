import type { CanvasObject, ConfigSnapshot, Placer, Pose, RoomState } from './types';
import type { Capacity } from './stage';
import { freshRoomState } from './schemas';
import { newChat, newNote } from './create';

/**
 * What a new room is born with (UX-ROOM-12).
 *
 * A room used to arrive empty: no objects, no newcomer spots, no saved
 * layouts. Everything the product is FOR had to be assembled by hand before
 * the first meeting, out of a host UI that only makes sense once you already
 * know what a configuration is. These three layouts are the three shapes
 * people actually arrive wanting — a gallery, a one-on-one, and a talk — and
 * they cost no new machinery: a layout was ALREADY a snapshot of placers,
 * capacity and per-object poses (UX-ROOM-3), so this file is data, not model.
 *
 * Two facts of the model do the work here, and both are easy to get backwards:
 *
 *   - **A video placeholder is not an object.** It is a newcomer placer — a
 *     positioned, sized, shaped arrival spot (UX-AV-2) — PLUS the layout's
 *     `max_av`. Capacity is a number and placement is a coordinate; UX-STAGE-1
 *     is explicit that fusing them is what made arrival order decide who could
 *     speak. So "five equal video spots" is five placers AND `max_av = 5`,
 *     stated separately.
 *   - **Every object exists in every configuration** (UX-ROOM-3). The room
 *     carries one chat and one note; a layout that does not want one poses it
 *     `hidden`, which holds no space and is reversible, rather than deleting
 *     it.
 *
 * Pure: no I/O, no randomness beyond ids, no store. The seeding write lives in
 * the `/new` action.
 */

/** The gutter between placers, and between a placer and any content. */
const GUTTER = 40;

/**
 * A layout, before ids exist. Poses are given as boxes; `null` means the
 * object is hidden in this layout.
 */
interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface Layout {
	name: string;
	capacity: Capacity;
	placers: readonly Omit<Placer, 'id'>[];
	chat: Box | null;
	note: Box | null;
}

/** A row of equal boxes, centred on x = 0. */
function row(count: number, width: number, height: number, y: number, gutter = GUTTER): Box[] {
	const span = count * width + (count - 1) * gutter;
	const left = -span / 2;
	return Array.from({ length: count }, (_, i) => ({
		x: left + i * (width + gutter),
		y,
		width,
		height
	}));
}

/** A `cols × rows` grid of equal boxes, centred on x = 0, starting at `top`. */
function grid(cols: number, rows: number, width: number, height: number, top: number, gutter = GUTTER): Box[] {
	return Array.from({ length: rows }, (_, r) =>
		row(cols, width, height, top + r * (height + gutter), gutter)
	).flat();
}

/** A rounded video-shaped arrival spot. */
function tile(box: Box): Omit<Placer, 'id'> {
	return { ...box, rotation: 0, clip: { shape: 'rounded', radius: 12 } };
}

/** A small circular arrival spot — an audience face, camera-off (UX-AV-3). */
function seat(box: Box): Omit<Placer, 'id'> {
	return { ...box, rotation: 0, clip: { shape: 'circle' } };
}

/**
 * The three layouts, as geometry.
 *
 * Each is centred on the origin so the canvas's auto-fit frames it on arrival.
 * The gutters are what keep placers from overlapping each other and the chat:
 * `add_placer` normally resolves overlap through `nearestLegal`, but these are
 * written straight into state, so the arithmetic is the only thing standing
 * between a host and a stack of spots on top of one another. `presets.spec.ts`
 * asserts it with the real solver rather than trusting the numbers here.
 */
const LAYOUTS: readonly Layout[] = [
	{
		name: 'Gallery',
		// Five people on camera; room for a dozen more listening.
		capacity: { max_participants: 20, max_av: 5, max_audio: 8 },
		placers: [...row(3, 240, 180, -200), ...row(2, 240, 180, 20)].map(tile),
		// Right of the grid, whose right edge is at x = 400.
		chat: { x: 440, y: -200, width: 300, height: 400 },
		note: null
	},
	{
		name: 'One on one',
		capacity: { max_participants: 8, max_av: 2, max_audio: 2 },
		placers: [
			{ x: -560, y: -120, width: 320, height: 240 },
			{ x: 240, y: -120, width: 320, height: 240 }
		].map(tile),
		chat: null,
		// Between the two of them: the shared page a one-on-one is really about.
		note: { x: -180, y: -150, width: 360, height: 300 }
	},
	{
		name: 'Featured speaker',
		// One speaker on camera, an audience that may speak but not send video —
		// which is what "35 small non-video participants" means in a model where
		// video and audio are separate capacity numbers (UX-STAGE-1).
		capacity: { max_participants: 36, max_av: 1, max_audio: 35 },
		placers: [
			tile({ x: -280, y: -300, width: 560, height: 420 }),
			...grid(7, 5, 88, 88, 160, 24).map(seat)
		],
		// Down the side, tall: a talk's chat scrolls.
		chat: { x: 440, y: -300, width: 300, height: 640 },
		note: null
	}
];

/**
 * The names, in order, READ from the layouts rather than restated beside them
 * — a second list would be a second source of truth the day one is renamed.
 */
export const PRESET_LAYOUT_NAMES: readonly string[] = LAYOUTS.map((layout) => layout.name);

/** A hidden object keeps its transform: hiding is reversible (UX-ROOM-3). */
function poseOf(object: CanvasObject, box: Box | null): Pose {
	if (box === null) return { transform: { ...object.transform }, hidden: true };
	return { transform: { ...box, rotation: 0, z: object.transform.z }, hidden: false };
}

function snapshotOf(layout: Layout, chat: CanvasObject, note: CanvasObject): ConfigSnapshot {
	return {
		poses: {
			[chat.id]: poseOf(chat, layout.chat),
			[note.id]: poseOf(note, layout.note)
		},
		placers: layout.placers.map((placer) => ({ ...placer, id: crypto.randomUUID() })),
		capacity: { ...layout.capacity },
		background: '',
		// Left empty on purpose. A configuration's title REPLACES the room's
		// (UX-ROOM-2), so seeding "Gallery" here would rename the space to the
		// name of its furniture arrangement; '' falls back to the room's name.
		title: '',
		description: ''
	};
}

/**
 * A new room, furnished (UX-ROOM-12).
 *
 * The first layout is active, and the LIVE scalars are made to agree with its
 * snapshot — same placers, same capacity, same object transforms — because
 * that is the invariant `switch_config` maintains and a room whose live state
 * disagreed with its own active configuration would repair itself, silently
 * and confusingly, the first time anyone hit reset.
 */
export function defaultRoomState(ownerId: string): RoomState {
	const state = freshRoomState();
	const origin = { x: 0, y: 0 };
	const chat = newChat(ownerId, origin, 0, state.border_default);
	const note = newNote(ownerId, origin, 1, state.border_default);
	state.objects = { [chat.id]: chat, [note.id]: note };

	const configs = LAYOUTS.map((layout) => ({
		id: crypto.randomUUID(),
		name: layout.name,
		snapshot: snapshotOf(layout, chat, note)
	}));
	for (const config of configs) state.configurations[config.id] = config;

	const active = configs[0];
	if (active === undefined) throw new Error('preset room has no layouts');
	state.active_config = active.id;
	for (const [id, pose] of Object.entries(active.snapshot.poses)) {
		const object = state.objects[id];
		if (object === undefined) continue;
		object.transform = { ...pose.transform };
		object.hidden = pose.hidden;
	}
	state.placers = active.snapshot.placers.map((placer) => ({ ...placer }));
	state.capacity = { ...active.snapshot.capacity };
	return state;
}
