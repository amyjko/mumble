import { describe, expect, it } from 'vitest';
import { applyMutation } from './rules';
import { canvasObjectSchema, imageObjectSchema, roomStateSchema } from './schemas';
import { newImage, type ImageRef } from './create';
import { newParticipant } from './avatar';
import { StoreRejection } from './types';
import type { ImageCanvasObject, RoomState } from './types';
import { MAX_IMAGE_DIM, MAX_IMAGES_PER_ROOM } from './image';

/**
 * Image objects (UX-OBJ-5).
 *
 * The point of contrast with a screen share: a share is refused by
 * `create_object` because it may only be born through `start_screenshare` (which
 * takes a slot in the same breath). An image needs no slot and no atomic
 * pairing, so it IS created the ordinary way — and these tests pin exactly that,
 * plus the schema caps that are the server-side half of the dimension gate
 * Storage cannot enforce.
 *
 * Node-only: `applyMutation` and the zod schemas are the same code the server
 * runs (AR-SYNC-3).
 */

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';

const at = { x: 0, y: 0 };

function room(over: Partial<RoomState> = {}): RoomState {
	const state = roomStateSchema.parse({ objects: {}, participants: {}, ...over });
	for (const id of [ALICE, BOB, CAROL]) {
		state.participants[id] = newParticipant({ id, name: id.slice(0, 4), emoji: '🐢' });
	}
	return state;
}

const asAlice = { actorId: ALICE, isHost: false };
const asBob = { actorId: BOB, isHost: false };
const asHost = { actorId: CAROL, isHost: true };

function ref(over: Partial<ImageRef> = {}): ImageRef {
	return {
		path: `${'0'.repeat(8)}-0000-4000-8000-000000000000/${crypto.randomUUID()}`,
		width: 800,
		height: 600,
		mime: 'image/png',
		alt: 'a cat',
		...over
	};
}

function image(over: Partial<ImageRef> = {}): ImageCanvasObject {
	return newImage(ALICE, at, 0, ref(over));
}

describe('an image is a plain object', () => {
	it('is created through create_object — unlike a screen share', () => {
		const state = room();
		const object = image();
		applyMutation(state, { kind: 'create_object', object }, asAlice);
		expect(state.objects[object.id]?.type).toBe('image');
	});

	it('preserves the natural aspect ratio in its transform', () => {
		const object = image({ width: 800, height: 400 });
		// 2:1 in, 2:1 out — never born stretched.
		expect(object.transform.width / object.transform.height).toBeCloseTo(2, 5);
	});

	it('seeds a non-empty payload from the reference', () => {
		const object = image({ path: 'room/key', mime: 'image/webp', alt: 'chart' });
		expect(object.payload).toMatchObject({ path: 'room/key', mime: 'image/webp', alt: 'chart' });
	});
});

describe('a room caps how many images it holds', () => {
	function fill(state: RoomState, count: number): void {
		for (let i = 0; i < count; i += 1) {
			applyMutation(state, { kind: 'create_object', object: image() }, asAlice);
		}
	}
	function imageCount(state: RoomState): number {
		return Object.values(state.objects).filter((o) => o.type === 'image').length;
	}

	it(`allows up to ${String(MAX_IMAGES_PER_ROOM)} and refuses the next`, () => {
		const state = room();
		fill(state, MAX_IMAGES_PER_ROOM);
		expect(imageCount(state)).toBe(MAX_IMAGES_PER_ROOM);
		expect(() => {
			applyMutation(state, { kind: 'create_object', object: image() }, asAlice);
		}).toThrow(StoreRejection);
	});

	it('counts only images — other object types do not fill the quota', () => {
		const state = room();
		// A full complement of images, then a note still lands: the cap is about
		// bytes-to-download, which notes do not incur.
		fill(state, MAX_IMAGES_PER_ROOM);
		const note = {
			id: crypto.randomUUID(),
			type: 'note' as const,
			creator_id: ALICE,
			permission: 'all' as const,
			transform: { x: 500, y: 500, width: 200, height: 160, rotation: 0, z: 1 },
			clip: { shape: 'rect' as const },
			border: { width: 10 },
			hidden: false,
			payload: { text: 'still fine', doc: '' },
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString()
		};
		applyMutation(state, { kind: 'create_object', object: note }, asAlice);
		expect(state.objects[note.id]?.type).toBe('note');
	});
});

describe('the schema is the server-side dimension and mime gate', () => {
	it('rejects a width past the pixel cap', () => {
		const bad = { ...image(), payload: { ...image().payload, width: MAX_IMAGE_DIM + 1 } };
		expect(imageObjectSchema.safeParse(bad).success).toBe(false);
	});

	it('rejects a height past the pixel cap', () => {
		const bad = { ...image(), payload: { ...image().payload, height: MAX_IMAGE_DIM + 1 } };
		expect(imageObjectSchema.safeParse(bad).success).toBe(false);
	});

	it('rejects a non-image / unlisted mime', () => {
		const bad = { ...image(), payload: { ...image().payload, mime: 'image/svg+xml' } };
		expect(imageObjectSchema.safeParse(bad).success).toBe(false);
	});

	it('defaults alt to the empty string when absent', () => {
		const object = image();
		const parsed = imageObjectSchema.parse({
			...object,
			payload: { path: 'room/key', width: 10, height: 10, mime: 'image/png' }
		});
		expect(parsed.payload.alt).toBe('');
	});

	it('accepts the image variant through the object union', () => {
		expect(canvasObjectSchema.safeParse(image()).success).toBe(true);
	});
});

describe('set_image_alt', () => {
	function withImage(permission: ImageCanvasObject['permission'] = 'all'): {
		state: RoomState;
		id: string;
	} {
		const state = room();
		const object = { ...image(), permission };
		applyMutation(state, { kind: 'create_object', object }, asAlice);
		return { state, id: object.id };
	}

	it('lets an editor change the accessible name', () => {
		const { state, id } = withImage('all');
		applyMutation(state, { kind: 'set_image_alt', id, alt: 'a napping cat' }, asBob);
		const object = state.objects[id];
		expect(object?.type === 'image' && object.payload.alt).toBe('a napping cat');
	});

	it('refuses a non-editor when permission is locked to the creator', () => {
		const { state, id } = withImage('none');
		expect(() => {
			applyMutation(state, { kind: 'set_image_alt', id, alt: 'hijacked' }, asBob);
		}).toThrow(StoreRejection);
	});

	it('always lets a host set it', () => {
		const { state, id } = withImage('host');
		applyMutation(state, { kind: 'set_image_alt', id, alt: 'host edit' }, asHost);
		const object = state.objects[id];
		expect(object?.type === 'image' && object.payload.alt).toBe('host edit');
	});

	it('refuses to set alt on an object that is not an image', () => {
		const state = room();
		const noteId = crypto.randomUUID();
		applyMutation(
			state,
			{
				kind: 'create_object',
				object: {
					id: noteId,
					type: 'note',
					creator_id: ALICE,
					permission: 'all',
					transform: { x: 0, y: 0, width: 200, height: 160, rotation: 0, z: 1 },
					clip: { shape: 'rect' },
					border: { width: 10 },
					hidden: false,
					payload: { text: 'hi', doc: '' },
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString()
				}
			},
			asAlice
		);
		expect(() => {
			applyMutation(state, { kind: 'set_image_alt', id: noteId, alt: 'nope' }, asAlice);
		}).toThrow(StoreRejection);
	});
});
