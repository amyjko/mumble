import { z } from 'zod';
import { isSafeBackground } from './background';
import { EMOTE_NAMES } from './emotes';

/**
 * The single source of truth for every shape that crosses a boundary:
 * BroadcastChannel messages, localStorage, and (later) server route payloads.
 * Types are derived via z.infer in types.ts — schema and type cannot drift.
 *
 * The object shape follows AR-CANVAS-3's polymorphic schema; the payload is a
 * discriminated union on `type`, so a note can never carry a timer's payload.
 */

export const transformSchema = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number().positive(),
	height: z.number().positive(),
	rotation: z.number(),
	z: z.number()
});

/**
 * Clip shapes (UX-OBJ-7). rect/rounded/circle use border-radius; ellipse and
 * polygon use percentage clip-path (which scales with the object). Arbitrary
 * `path` clipping was STRUCK from the requirements (2026-07-18): the border
 * width is the overlap tolerance, so it would need an arbitrary-path collider,
 * not just a renderer. Polygon points are percentages (0–100) of the box.
 */
export const clipSchema = z.discriminatedUnion('shape', [
	z.object({ shape: z.literal('rect') }),
	z.object({ shape: z.literal('rounded'), radius: z.number().nonnegative() }),
	z.object({ shape: z.literal('circle') }),
	z.object({ shape: z.literal('ellipse') }),
	z.object({
		shape: z.literal('polygon'),
		points: z.array(z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) })).min(3).max(16)
	})
]);

/**
 * Sticker border (UX-OBJ-8). Its width IS the overlap tolerance (UX-OBJ-12),
 * which is why the ceiling is modest: a very wide border would let objects
 * overlap so far that "content never covers content" stops meaning anything.
 */
export const borderSchema = z.object({
	width: z.number().nonnegative().max(40)
});

/** The room/theme default UX-OBJ-8 calls for; per-object overrides sit on top. */
export const DEFAULT_BORDER_WIDTH = 10;

export const permissionSchema = z.enum(['host', 'all', 'none']);

const objectBase = z.object({
	id: z.uuid(),
	creator_id: z.uuid(),
	permission: permissionSchema,
	transform: transformSchema,
	clip: clipSchema,
	border: borderSchema,
	/**
	 * Visibility (UX-ROOM-3). Lives on the OBJECT, not only in a configuration
	 * snapshot: toggling visibility while no configuration is active would
	 * otherwise have nowhere to write. A hidden object still exists for
	 * everyone; only its creator (and, when the role lands, a host) can see it.
	 * Defaults keep objects stored before this valid.
	 */
	hidden: z.boolean().default(false),
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime()
});

/**
 * A note (UX-OBJ-2) is collaboratively edited, so its text is a CRDT
 * document, not a string (AR-SYNC-4).
 *
 * `doc` is the authoritative value: base64-encoded Yjs state. `text` is a
 * MATERIALIZED copy kept alongside it, because plenty of the app needs a plain
 * string and should not have to decode a CRDT to get one — markdown rendering,
 * the accessible name, and eventually search. Anything that WRITES goes
 * through `doc`; `text` is derived from it on every apply and never edited
 * directly.
 */
export const noteObjectSchema = objectBase.extend({
	type: z.literal('note'),
	payload: z.object({
		text: z.string(),
		doc: z.string().default('')
	})
});

/**
 * Timer state (UX-OBJ-4) is anchored to shared timestamps, not per-client
 * ticking, so every viewer computes the same displayed time: elapsed =
 * elapsedBeforeMs + (running ? now - startedAt : 0). Clients tick locally only
 * for the display. `startedAt` is epoch ms (a number, cross-viewer at stub
 * fidelity; server time supersedes it when the real backend lands).
 */
export const timerPayloadSchema = z.object({
	mode: z.enum(['countdown', 'countup']),
	durationMs: z.number().nonnegative(),
	running: z.boolean(),
	startedAt: z.number().nullable(),
	elapsedBeforeMs: z.number().nonnegative()
});

export const timerObjectSchema = objectBase.extend({
	type: z.literal('timer'),
	payload: timerPayloadSchema
});

/** A chat message (UX-OBJ-3): room state, retained. Author is stamped at post. */
export const chatMessageSchema = z.object({
	id: z.uuid(),
	author_id: z.uuid(),
	author_name: z.string().min(1),
	text: z.string().min(1),
	at: z.iso.datetime()
});

export const chatObjectSchema = objectBase.extend({
	type: z.literal('chat'),
	payload: z.object({ messages: z.array(chatMessageSchema) })
});

/** A drawing (UX-OBJ-11): one colored stroke, points normalized 0–100. */
const safeColor = z.string().regex(/^#[0-9a-fA-F]{3,8}$|^rgb\(/, 'Unsafe color');
export const drawingObjectSchema = objectBase.extend({
	type: z.literal('drawing'),
	payload: z.object({
		color: safeColor,
		width: z.number().positive().max(40),
		points: z.array(z.object({ x: z.number(), y: z.number() })).min(1).max(2000)
	})
});

/** Grows into a wider discriminated union as object types land (AR-CANVAS-3). */
export const canvasObjectSchema = z.discriminatedUnion('type', [
	noteObjectSchema,
	timerObjectSchema,
	chatObjectSchema,
	drawingObjectSchema
]);

export const slotMediaSchema = z.enum(['video', 'audio']);

/** UX-STAGE-1's three numbers. Publish caps may not exceed the room size. */
export const capacitySchema = z.object({
	max_participants: z.number().int().min(1).max(200).default(20),
	max_av: z.number().int().min(0).max(200).default(4),
	max_audio: z.number().int().min(0).max(200).default(8)
});

export const participantSchema = z.object({
	id: z.uuid(),
	name: z.string().min(1),
	/** Camera-off emoji (UX-AV-3); the whole avatar in slice 1. */
	emoji: z.string().min(1),
	/** Shared placement (UX-AV-2): everyone sees participants in the same spots. */
	location: z.object({ x: z.number(), y: z.number() }),
	/**
	 * Avatars are canvas objects too (UX-AV-1), so they carry the same size,
	 * rotation, and clip as any other object rather than being locked to a
	 * fixed circle. Defaults keep participants stored before this valid, and
	 * reproduce the previous fixed-circle appearance exactly.
	 */
	size: z.object({ width: z.number().positive(), height: z.number().positive() }).default({ width: 96, height: 96 }),
	rotation: z.number().default(0),
	clip: clipSchema.default({ shape: 'circle' }),
	/** Dev-panel fakes are marked so they can be styled/cleared distinctly. */
	fake: z.boolean(),
	/**
	 * Stepped-away (UX-AV-5), a persistent emote. Raise-hand USED to live here
	 * too; it is now derived from queue membership, because UX-AV-6 says
	 * raise-hand IS the slot-request queue entry and two sources of truth would
	 * drift the moment a handoff promoted someone (nothing would lower the
	 * hand). Zod strips unknown keys, so stored participants migrate for free.
	 */
	away: z.boolean().default(false),
	/** Mic state (UX-STAGE-10). You arrive silent and opt in by unmuting. */
	muted: z.boolean().default(true)
});

/**
 * Configurations (UX-ROOM-3..6). A configuration is a saved LAYOUT — the word
 * the product uses — and it holds one POSE per object: where that object sits,
 * how big it is, and whether it is shown, plus the room's
 * background/title/description.
 *
 * "Pose" rather than "layout" for the per-object record, because "layout" is
 * now the user-facing name for the whole saved configuration and one word
 * cannot be both the set and its members. Not "shape" either: that already
 * means the clip silhouette (`clip.shape`) and the solver polygon
 * (`SolverShape`), and a third meaning would put all three in one expression.
 * A pose carries `hidden` alongside the transform, which stretches the word
 * slightly — a deliberate trade for a name that collides with nothing.
 *
 * This resolves the old "hide vs remove" open item by dissolving it: every
 * object exists in every configuration, and configurations differ only in
 * where objects sit, how big they are, and whether they are shown. Nothing is
 * ever removed, so there is no question of what happens to an object present
 * in one configuration and absent from another.
 *
 * Content stays at the room level: switching never touches note text or chat
 * logs (UX-ROOM-5).
 */
export const poseSchema = z.object({
	transform: transformSchema,
	hidden: z.boolean().default(false)
});

export const pointSchema = z.object({ x: z.number(), y: z.number() });

/**
 * A newcomer placer (UX-AV-2): a numbered spot a host lays out to say where
 * arrivals should appear and what they should look like when they do.
 *
 * NOT an object, and the distinction is load-bearing: a placer holds no space
 * in the solver, carries no permission of its own, never appears in a
 * configuration's object layout, and is invisible to the people it places. It
 * is a property OF the configuration that happens to be positioned.
 *
 * It carries a full transform and clip rather than a bare point because the
 * placer DEFINES the arrival: whoever lands here adopts its size, rotation,
 * and shape. That is what makes the resize and rotate handles mean something
 * instead of decorating a marker.
 *
 * Number is array position, not a stored field. A stored index drifts the
 * first time one is deleted from the middle, and "newcomer 4" with no
 * newcomer 3 is a bug the user has to interpret.
 */
export const placerSchema = z.object({
	id: z.uuid(),
	/** No `z`: placers never interleave with content, they sit under avatars. */
	x: z.number(),
	y: z.number(),
	width: z.number().positive(),
	height: z.number().positive(),
	rotation: z.number(),
	clip: clipSchema
});

export const configSnapshotSchema = z.object({
	poses: z.record(z.uuid(), poseSchema),
	/**
	 * Where newcomers appear in this configuration, in order (UX-AV-2). A
	 * configuration with no placers still works — arrivals fall through to
	 * nearest-legal, which is what every room did before placers existed.
	 */
	placers: z.array(placerSchema).default([]),
	/** UX-STAGE-1: the numbers belong to the configuration, not the room. */
	capacity: capacitySchema.default({ max_participants: 20, max_av: 4, max_audio: 8 }),
	background: z.string(),
	title: z.string(),
	description: z.string()
});


export const configurationSchema = z.object({
	id: z.uuid(),
	name: z.string().min(1).max(60),
	snapshot: configSnapshotSchema
});

export const roomStateSchema = z.object({
	objects: z.record(z.uuid(), canvasObjectSchema),
	participants: z.record(z.uuid(), participantSchema),
	/** Shared canvas background (UX-CANVAS-5); '' = the default token bg. */
	background: z.string().default(''),
	/** Room title/description (UX-ROOM-2); '' title falls back to the name. */
	title: z.string().max(120).default(''),
	description: z.string().max(2000).default(''),
	/**
	 * Who may add objects (UX-OBJ-9): "creation permission is a room setting
	 * (default: all may create, hosts may restrict)". The 'host' value is
	 * enforceable but unreachable until the role exists, exactly as canEdit's
	 * host branch is.
	 */
	create_permission: z.enum(['all', 'host']).default('all'),
	/**
	 * The stage (AR-CTRL-2). Holder lists are EXPLICIT, never derived — they
	 * are the authorization fact UX-STAGE-9 renders and UX-STAGE-6 enforces.
	 * `capacity` mirrors the active configuration's numbers (UX-STAGE-1).
	 * `transport` is carried inert at 'p2p': it is a V2 media-plane fact
	 * (AR-TRANSPORT-6) parked here now so adding it later is not a migration.
	 */
	capacity: capacitySchema.default({ max_participants: 20, max_av: 4, max_audio: 8 }),
	video_holders: z.array(z.uuid()).default([]),
	audio_holders: z.array(z.uuid()).default([]),
	queue: z.array(z.uuid()).default([]),
	transport: z.enum(['p2p', 'promoting', 'sfu', 'demoting']).default('p2p'),
	/** UX-OBJ-8's room default. New objects inherit it; each may override. */
	border_default: z.number().nonnegative().max(40).default(DEFAULT_BORDER_WIDTH),
	/**
	 * Remembered placement, keyed (participant, configuration) — AR-CTRL-6's
	 * triple minus room_id, which the store already scopes.
	 *
	 * Separate from both objects and the stage, deliberately: capacity is a
	 * count, placement is a coordinate, and fusing them is what made arrival
	 * order decide who could speak. Keyed per configuration so your spot in
	 * "Standup" never leaks into "Retro" (UX-AV-9).
	 */
	participant_locations: z.record(z.string(), pointSchema).default({}),
	/** The live placers; a configuration switch re-applies its own set. */
	placers: z.array(placerSchema).default([]),
	configurations: z.record(z.uuid(), configurationSchema).default({}),
	active_config: z.uuid().nullable().default(null)
});

/**
 * Mutations — the seam's vocabulary. These same schemas later validate the
 * bodies of AR-SYNC-3's server routes; the stub and the real backend speak
 * one language.
 */
export const mutationSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('create_object'), object: canvasObjectSchema }),
	z.object({ kind: z.literal('move_object'), id: z.uuid(), transform: transformSchema }),
	/**
	 * An edit is a Yjs UPDATE, not a replacement string. That is what lets two
	 * people type at once: updates merge, whole-text writes clobber.
	 */
	z.object({ kind: z.literal('edit_note'), id: z.uuid(), update: z.string() }),
	z.object({ kind: z.literal('edit_timer'), id: z.uuid(), payload: timerPayloadSchema }),
	z.object({ kind: z.literal('post_message'), id: z.uuid(), message: chatMessageSchema }),
	z.object({ kind: z.literal('set_clip'), id: z.uuid(), clip: clipSchema }),
	// Visibility is layout, so it is a per-configuration property (UX-ROOM-3).
	z.object({ kind: z.literal('set_hidden'), id: z.uuid(), hidden: z.boolean() }),
	// UX-PERM-1's enum has existed and been tested since slice 1, but nothing
	// could SET it — every object was born 'all', so the host and none branches
	// had never run in the product. Creator-only: deciding who may edit your
	// object is itself a creator's decision.
	z.object({ kind: z.literal('set_permission'), id: z.uuid(), permission: permissionSchema }),
	// UX-OBJ-8's per-object override, "subject to edit permission" — so this
	// goes through requireEditable rather than being creator-only.
	z.object({ kind: z.literal('set_border'), id: z.uuid(), width: z.number().nonnegative().max(40) }),
	z.object({ kind: z.literal('set_room_border'), width: z.number().nonnegative().max(40) }),
	// The room-level half of UX-OBJ-9.
	z.object({ kind: z.literal('set_room_create_permission'), value: z.enum(['all', 'host']) }),
	z.object({ kind: z.literal('delete_object'), id: z.uuid() }),
	z.object({ kind: z.literal('upsert_participant'), participant: participantSchema }),
	z.object({
		kind: z.literal('move_participant'),
		id: z.uuid(),
		location: z.object({ x: z.number(), y: z.number() })
	}),
	z.object({ kind: z.literal('remove_participant'), id: z.uuid() }),
	// Avatars resize/rotate/reshape like any other object (UX-AV-1).
	z.object({
		kind: z.literal('size_participant'),
		id: z.uuid(),
		location: z.object({ x: z.number(), y: z.number() }),
		size: z.object({ width: z.number().positive(), height: z.number().positive() }),
		rotation: z.number()
	}),
	z.object({ kind: z.literal('set_participant_clip'), id: z.uuid(), clip: clipSchema }),
	// UX-AV-6: raising a hand IS entering the queue, so this keeps its name and
	// changes meaning rather than growing a second, near-identical mutation.
	z.object({ kind: z.literal('set_hand'), id: z.uuid(), raised: z.boolean() }),
	z.object({ kind: z.literal('take_slot'), id: z.uuid(), media: slotMediaSchema }),
	z.object({ kind: z.literal('release_slot'), id: z.uuid(), media: slotMediaSchema }),
	z.object({ kind: z.literal('set_muted'), id: z.uuid(), muted: z.boolean() }),
	z.object({ kind: z.literal('grant_slot'), id: z.uuid(), media: slotMediaSchema }),
	z.object({ kind: z.literal('revoke_slot'), id: z.uuid(), media: slotMediaSchema }),
	z.object({ kind: z.literal('set_capacity'), capacity: capacitySchema }),
	/**
	 * Hosts lay out newcomer placers (UX-AV-2). Transform and clip are set with
	 * the same gestures as an object's, so the whole placer is one mutation
	 * rather than a position/size/rotation/shape family.
	 */
	z.object({ kind: z.literal('add_placer'), placer: placerSchema }),
	z.object({ kind: z.literal('update_placer'), placer: placerSchema }),
	z.object({ kind: z.literal('remove_placer'), id: z.uuid() }),
	z.object({ kind: z.literal('set_away'), id: z.uuid(), away: z.boolean() }),
	// Change your own name or camera-off face (UX-ID-1, UX-AV-3). Self-only:
	// your identity is yours, the same rule that governs emotes (UX-AV-7).
	z.object({
		kind: z.literal('set_identity'),
		id: z.uuid(),
		name: z.string().min(1).max(40),
		emoji: z.string().min(1)
	}),
	z.object({
		kind: z.literal('set_background'),
		value: z.string().refine(isSafeBackground, 'Unsafe background value')
	}),
	z.object({
		kind: z.literal('set_room_meta'),
		title: z.string().max(120),
		description: z.string().max(2000)
	}),
	z.object({ kind: z.literal('save_config'), id: z.uuid(), name: z.string().min(1).max(60) }),
	z.object({ kind: z.literal('switch_config'), id: z.uuid() }),
	/**
	 * Update the ACTIVE configuration in place (UX-ROOM-4/6). Without this,
	 * "save" only ever minted a new id, so configurations accumulated and could
	 * never be corrected. Targeting the active one is not a convenience: UX-ROOM-4
	 * requires that what you are editing and what participants see are the same
	 * thing.
	 */
	z.object({ kind: z.literal('update_config') }),
	z.object({ kind: z.literal('rename_config'), id: z.uuid(), name: z.string().min(1).max(60) }),
	z.object({ kind: z.literal('reset_config') }),
	z.object({ kind: z.literal('delete_config'), id: z.uuid() })
]);

/** Ephemeral traffic (AR-SYNC-1 class 2/3): never persisted, throttled ~15–20 Hz. */
export const ephemeralSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('drag_object'), id: z.uuid(), transform: transformSchema }),
	z.object({
		kind: z.literal('drag_participant'),
		id: z.uuid(),
		location: z.object({ x: z.number(), y: z.number() })
	}),
	z.object({ kind: z.literal('drag_end'), id: z.uuid() }),
	z.object({ kind: z.literal('emote'), id: z.uuid(), emote: z.enum(EMOTE_NAMES) })
]);

/**
 * The versioned cross-tab envelope. A stale tab running older code sends v≠1
 * and is silently ignored — modeling the stale-client reality the real
 * backend will have. `state` broadcasts a full snapshot after each commit
 * (convergence over cleverness, at prototype scale); `hello` asks peers to
 * re-broadcast state for a newly opened tab.
 */
export const envelopeSchema = z.discriminatedUnion('t', [
	z.object({ v: z.literal(1), t: z.literal('state'), state: roomStateSchema }),
	z.object({ v: z.literal(1), t: z.literal('ephemeral'), message: ephemeralSchema }),
	z.object({ v: z.literal(1), t: z.literal('hello') })
]);

/** localStorage shapes (per-browser identity echoing UX-ID-5). */
export const storedIdentitySchema = z.object({
	id: z.uuid(),
	name: z.string().min(1),
	emoji: z.string().min(1)
});

/** The one sanctioned any→unknown laundering point (STACK.md §4 norms). */
export const parseJson = (text: string): unknown => JSON.parse(text);
