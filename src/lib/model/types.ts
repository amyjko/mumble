import type { z } from 'zod';
import type {
	noteObjectSchema,
	timerObjectSchema,
	timerPayloadSchema,
	transformSchema,
	clipSchema,
	permissionSchema,
	canvasObjectSchema,
	participantSchema,
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
export type Participant = z.infer<typeof participantSchema>;
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
	circle: boolean;
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
