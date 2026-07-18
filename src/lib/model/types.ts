import type { z } from 'zod';
import type {
	noteObjectSchema,
	timerObjectSchema,
	timerPayloadSchema,
	chatObjectSchema,
	chatMessageSchema,
	drawingObjectSchema,
	transformSchema,
	clipSchema,
	permissionSchema,
	canvasObjectSchema,
	participantSchema,
	layoutSchema,
	configSnapshotSchema,
	configurationSchema,
	roomStateSchema,
	mutationSchema,
	ephemeralSchema,
	envelopeSchema,
	storedIdentitySchema
} from './schemas';

/** Boundary-crossing types are inferred from schemas — no drift possible. */
export type Transform = z.infer<typeof transformSchema>;
export type Clip = z.infer<typeof clipSchema>;
export type Permission = z.infer<typeof permissionSchema>;
export type CanvasObject = z.infer<typeof canvasObjectSchema>;
export type NoteCanvasObject = z.infer<typeof noteObjectSchema>;
export type TimerCanvasObject = z.infer<typeof timerObjectSchema>;
export type TimerPayload = z.infer<typeof timerPayloadSchema>;
export type ChatCanvasObject = z.infer<typeof chatObjectSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type DrawingCanvasObject = z.infer<typeof drawingObjectSchema>;
export type Participant = z.infer<typeof participantSchema>;
/** A configuration's per-object layout: position, size, and visibility. */
export type Layout = z.infer<typeof layoutSchema>;
export type ConfigSnapshot = z.infer<typeof configSnapshotSchema>;
export type Configuration = z.infer<typeof configurationSchema>;
export type RoomState = z.infer<typeof roomStateSchema>;
export type Mutation = z.infer<typeof mutationSchema>;
export type EphemeralMessage = z.infer<typeof ephemeralSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;
export type StoredIdentity = z.infer<typeof storedIdentitySchema>;

/** Purely-internal types: never cross a boundary, so plain TS is fine. */

/** Plain-TS timestamp helper (kept out of .svelte.ts for lint's Date rule). */
export const nowIso = (): string => new Date().toISOString();

/** Remove a key from a record immutably (plays well with $state). */
export function omitKey<V>(record: Record<string, V>, key: string): Record<string, V> {
	const out: Record<string, V> = {};
	for (const [k, v] of Object.entries(record)) if (k !== key) out[k] = v;
	return out;
}

/** Per-viewer camera (UX-CANVAS-2): "what I'm looking at" is mine alone. */
export interface Camera {
	x: number;
	y: number;
	scale: number;
}

export interface Point {
	x: number;
	y: number;
}

export interface Size {
	width: number;
	height: number;
}

/** Axis-aligned bounds plus the clip/border facts the solver needs. */
export interface SolverShape {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	/**
	 * Degrees, matching the rendered transform. Collision used to ignore
	 * rotation entirely, so a rotated object collided as its unrotated bounding
	 * box — visibly wrong the moment anything was turned.
	 */
	rotation: number;
	/**
	 * Circles are kept as a special case rather than tessellated: they are
	 * exact, cheaper, and rotation-invariant.
	 */
	circle: boolean;
	/**
	 * Outline as PERCENTAGES (0–100) of the shape's box, for anything that is
	 * not a circle. Undefined means a plain rectangle. Ellipses arrive
	 * pre-tessellated. Percentages are what make the collider match the
	 * renderer: the drawn content layer is this same percentage shape applied
	 * to the border-inset box, so the collider reproduces the visible
	 * silhouette instead of approximating it.
	 */
	points?: readonly { x: number; y: number }[] | undefined;
	/** Sticker border width — the permitted overlap (UX-OBJ-12). */
	border: number;
}

/** A commit denial from the store; message is user-facing. */
export class StoreRejection extends Error {
	readonly reason: 'permission' | 'overlap' | 'forced' | 'invalid';

	constructor(reason: 'permission' | 'overlap' | 'forced' | 'invalid', message: string) {
		super(message);
		this.name = 'StoreRejection';
		this.reason = reason;
	}
}
