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
 * `path` clipping is deferred — it needs an SVG objectBoundingBox clipPath and
 * a matching sticker-border stroke, the open item AR-CANVAS-2 already names.
 * Polygon points are percentages (0–100) of the object's box.
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

/** Sticker border (UX-OBJ-8). Its width IS the overlap tolerance (UX-OBJ-12). */
export const borderSchema = z.object({
	width: z.number().nonnegative()
});

export const permissionSchema = z.enum(['host', 'all', 'none']);

const objectBase = z.object({
	id: z.uuid(),
	creator_id: z.uuid(),
	permission: permissionSchema,
	transform: transformSchema,
	clip: clipSchema,
	border: borderSchema,
	default_transform: transformSchema,
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime()
});

export const noteObjectSchema = objectBase.extend({
	type: z.literal('note'),
	payload: z.object({ text: z.string() })
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

export const participantSchema = z.object({
	id: z.uuid(),
	name: z.string().min(1),
	/** Camera-off emoji (UX-AV-3); the whole avatar in slice 1. */
	emoji: z.string().min(1),
	/** Shared placement (UX-AV-2): everyone sees participants in the same spots. */
	location: z.object({ x: z.number(), y: z.number() }),
	/** Dev-panel fakes are marked so they can be styled/cleared distinctly. */
	fake: z.boolean(),
	/** Persistent emotes (UX-AV-5): raise-hand and stepped-away. Persist even
	 * after leaving. Defaults keep older stored participants valid. */
	raised_hand: z.boolean().default(false),
	away: z.boolean().default(false)
});

/**
 * Configurations (UX-ROOM-3..6). A configuration is a NAMED SNAPSHOT of layout:
 * per-object transforms plus background/title/description. Switching re-applies
 * a snapshot to the live objects; reset (UX-ROOM-5) re-applies the active
 * snapshot (layout only — content persists). This additive snapshot model keeps
 * object CONTENT at the room level and LAYOUT in the snapshot, without
 * restructuring the object schema.
 *
 * DEFERRED (explicit DESIGN.md open item): what happens to objects present in
 * one config but not another — hide vs remove. Here, objects absent from a
 * snapshot are left in place on switch; the real semantics await a decision.
 */
export const configSnapshotSchema = z.object({
	transforms: z.record(z.uuid(), transformSchema),
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
	z.object({
		kind: z.literal('edit_note'),
		id: z.uuid(),
		payload: z.object({ text: z.string() })
	}),
	z.object({ kind: z.literal('edit_timer'), id: z.uuid(), payload: timerPayloadSchema }),
	z.object({ kind: z.literal('post_message'), id: z.uuid(), message: chatMessageSchema }),
	z.object({ kind: z.literal('set_clip'), id: z.uuid(), clip: clipSchema }),
	z.object({ kind: z.literal('delete_object'), id: z.uuid() }),
	z.object({ kind: z.literal('upsert_participant'), participant: participantSchema }),
	z.object({
		kind: z.literal('move_participant'),
		id: z.uuid(),
		location: z.object({ x: z.number(), y: z.number() })
	}),
	z.object({ kind: z.literal('remove_participant'), id: z.uuid() }),
	z.object({ kind: z.literal('set_hand'), id: z.uuid(), raised: z.boolean() }),
	z.object({ kind: z.literal('set_away'), id: z.uuid(), away: z.boolean() }),
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
