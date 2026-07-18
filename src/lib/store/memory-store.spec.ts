import { afterEach, describe, expect, it, vi } from 'vitest';
import { AVATAR_SIZE, MemoryRoomStore } from './memory-store.svelte';
import { StoreRejection } from '$lib/model/types';
import type { CanvasObject, Participant } from '$lib/model/types';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

let seq = 0;
const uuid = (): string => {
	seq += 1;
	return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
};

const note = (creator: string, x: number, permission: 'host' | 'all' | 'none' = 'all'): CanvasObject => {
	const transform = { x, y: 0, width: 100, height: 100, rotation: 0, z: 1 };
	return {
		id: uuid(),
		type: 'note',
		creator_id: creator,
		permission,
		transform,
		clip: { shape: 'rect' },
		border: { width: 10 },
		default_transform: transform,
		payload: { text: '' },
		created_at: '2026-07-17T00:00:00.000Z',
		updated_at: '2026-07-17T00:00:00.000Z'
	};
};

/** Participant fixture. Mirrors the schema defaults for size/rotation/clip. */
const person = (id: string): Participant => ({
	id,
	name: 'a',
	emoji: 'x',
	location: { x: 0, y: 0 },
	size: { width: AVATAR_SIZE, height: AVATAR_SIZE },
	rotation: 0,
	clip: { shape: 'circle' },
	fake: false,
	raised_hand: false,
	away: false
});

const stores: MemoryRoomStore[] = [];
const makeStore = (room: string, actor: string): MemoryRoomStore => {
	const store = new MemoryRoomStore(room, actor);
	stores.push(store);
	return store;
};

afterEach(() => {
	for (const store of stores.splice(0)) store.dispose();
});

describe('MemoryRoomStore commits', () => {
	it('creates and moves an object', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const object = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object });
		await store.commit({
			kind: 'move_object',
			id: object.id,
			transform: { ...object.transform, x: 500 }
		});
		expect(store.state.objects[object.id]?.transform.x).toBe(500);
	});

	it("denies edits to another creator's `none` object (UX-PERM-1/4)", async () => {
		const store = makeStore(`r${String(Math.random())}`, BOB);
		const locked = note(ALICE, 0, 'none');
		await store.commit({ kind: 'create_object', object: locked });
		await expect(
			store.commit({ kind: 'move_object', id: locked.id, transform: { ...locked.transform, x: 50 } })
		).rejects.toMatchObject({ reason: 'permission' });
	});

	it('rejects content-overlapping placement at commit (AR-CANVAS-5 server pass)', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const a = note(ALICE, 0);
		const b = note(ALICE, 300);
		await store.commit({ kind: 'create_object', object: a });
		await store.commit({ kind: 'create_object', object: b });
		await expect(
			store.commit({ kind: 'move_object', id: a.id, transform: { ...a.transform, x: 300 } })
		).rejects.toMatchObject({ reason: 'overlap' });
	});

	it('adjusts a colliding create to the nearest legal spot (AR-CTRL-4 shape)', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const a = note(ALICE, 0);
		const b = note(ALICE, 0); // identical desired spot
		await store.commit({ kind: 'create_object', object: a });
		await store.commit({ kind: 'create_object', object: b });
		const placed = store.state.objects[b.id];
		if (placed === undefined) throw new Error('object was not placed');
		expect(placed.transform.x === 0 && placed.transform.y === 0).toBe(false);
	});

	it('forced rejection fires once and clears (dev panel semantics)', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		store.rejectNext = true;
		await expect(store.commit({ kind: 'create_object', object: note(ALICE, 0) })).rejects.toBeInstanceOf(
			StoreRejection
		);
		expect(store.rejectNext).toBe(false);
		await expect(store.commit({ kind: 'create_object', object: note(ALICE, 900) })).resolves.toBeUndefined();
	});

	it('injected latency delays confirmation (AR-SYNC-2 is real here)', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		store.latencyMs = 60;
		const started = performance.now();
		await store.commit({ kind: 'create_object', object: note(ALICE, 0) });
		expect(performance.now() - started).toBeGreaterThanOrEqual(55);
	});
});

describe('cross-tab sync (real BroadcastChannel — Node has it)', () => {
	it('a commit in one store appears in a peer store on the same room', async () => {
		const room = `r${String(Math.random())}`;
		const a = makeStore(room, ALICE);
		const b = makeStore(room, BOB);
		const object = note(ALICE, 0);
		await a.commit({ kind: 'create_object', object });
		await vi.waitFor(() => {
			expect(b.state.objects[object.id]).toBeDefined();
		});
	});

	it('malformed and stale-version messages are dropped, never thrown', async () => {
		const room = `r${String(Math.random())}`;
		const store = makeStore(room, ALICE);
		await store.commit({ kind: 'create_object', object: note(ALICE, 0) });
		const before = Object.keys(store.state.objects).length;
		const rogue = new BroadcastChannel(`mumble:${room}`);
		rogue.postMessage({ garbage: true });
		rogue.postMessage({ v: 99, t: 'state', state: { objects: {}, participants: {} } });
		await new Promise((resolve) => setTimeout(resolve, 50));
		rogue.close();
		expect(Object.keys(store.state.objects).length).toBe(before);
	});
});

describe('timer object (UX-OBJ-4) + union type guards', () => {
	const timer = (creator: string, x: number) => {
		const transform = { x, y: 0, width: 180, height: 120, rotation: 0, z: 1 };
		return {
			id: uuid(),
			type: 'timer' as const,
			creator_id: creator,
			permission: 'all' as const,
			transform,
			clip: { shape: 'rounded' as const, radius: 8 },
			border: { width: 10 },
			default_transform: transform,
			payload: { mode: 'countdown' as const, durationMs: 60000, running: false, startedAt: null, elapsedBeforeMs: 0 },
			created_at: '2026-07-17T00:00:00.000Z',
			updated_at: '2026-07-17T00:00:00.000Z'
		};
	};

	it('creates a timer and edits its payload', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const t = timer(ALICE, 0);
		await store.commit({ kind: 'create_object', object: t });
		await store.commit({
			kind: 'edit_timer',
			id: t.id,
			payload: { mode: 'countdown', durationMs: 60000, running: true, startedAt: 1000, elapsedBeforeMs: 0 }
		});
		const got = store.state.objects[t.id];
		expect(got?.type).toBe('timer');
		if (got?.type === 'timer') expect(got.payload.running).toBe(true);
	});

	it('rejects edit_timer on a note and edit_note on a timer (guard)', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const n = note(ALICE, 0);
		const t = timer(ALICE, 400);
		await store.commit({ kind: 'create_object', object: n });
		await store.commit({ kind: 'create_object', object: t });
		await expect(
			store.commit({ kind: 'edit_timer', id: n.id, payload: { mode: 'countup', durationMs: 0, running: false, startedAt: null, elapsedBeforeMs: 0 } })
		).rejects.toMatchObject({ reason: 'invalid' });
		await expect(
			store.commit({ kind: 'edit_note', id: t.id, payload: { text: 'x' } })
		).rejects.toMatchObject({ reason: 'invalid' });
	});
});

describe('chat object (UX-OBJ-3) — retained log, open posting', () => {
	const chat = (creator: string, permission: 'all' | 'none' = 'all') => {
		const transform = { x: 0, y: 0, width: 280, height: 220, rotation: 0, z: 1 };
		return {
			id: uuid(), type: 'chat' as const, creator_id: creator, permission,
			transform, clip: { shape: 'rounded' as const, radius: 8 }, border: { width: 10 },
			default_transform: transform, payload: { messages: [] },
			created_at: '2026-07-17T00:00:00.000Z', updated_at: '2026-07-17T00:00:00.000Z'
		};
	};
	const msg = (author: string, text: string) => ({
		id: uuid(), author_id: author, author_name: 'x', text, at: '2026-07-17T00:00:00.000Z'
	});

	it('appends messages and retains them in order', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const c = chat(ALICE);
		await store.commit({ kind: 'create_object', object: c });
		await store.commit({ kind: 'post_message', id: c.id, message: msg(ALICE, 'one') });
		await store.commit({ kind: 'post_message', id: c.id, message: msg(BOB, 'two') });
		const got = store.state.objects[c.id];
		expect(got?.type).toBe('chat');
		if (got?.type === 'chat') expect(got.payload.messages.map((m) => m.text)).toEqual(['one', 'two']);
	});

	it('posting is open even on a `none`-permission chat owned by someone else', async () => {
		const store = makeStore(`r${String(Math.random())}`, BOB);
		const c = chat(ALICE, 'none'); // Alice owns it, locked to editing
		await store.commit({ kind: 'create_object', object: c });
		// Bob can still post (participation != layout editing)...
		await expect(store.commit({ kind: 'post_message', id: c.id, message: msg(BOB, 'hi') })).resolves.toBeUndefined();
		// ...but cannot MOVE it (that obeys permission).
		await expect(
			store.commit({ kind: 'move_object', id: c.id, transform: { ...c.transform, x: 99 } })
		).rejects.toMatchObject({ reason: 'permission' });
	});

	it('rejects post_message to a non-chat object', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const n = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object: n });
		await expect(store.commit({ kind: 'post_message', id: n.id, message: msg(ALICE, 'x') })).rejects.toMatchObject({ reason: 'invalid' });
	});
});

describe('canvas background (UX-CANVAS-5)', () => {
	it('sets a safe background into shared state', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		await store.commit({ kind: 'set_background', value: 'var(--surface-2)' });
		expect(store.state.background).toBe('var(--surface-2)');
	});

	it('the seam rejects an unsafe background value (schema refine)', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		await expect(
			store.commit({ kind: 'set_background', value: 'url(https://evil/x)' })
		).rejects.toMatchObject({ reason: 'invalid' });
		expect(store.state.background).toBe('');
	});
});

describe('clip shapes (UX-OBJ-7)', () => {
	it('set_clip changes an editable object\'s shape', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const n = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object: n });
		await store.commit({ kind: 'set_clip', id: n.id, clip: { shape: 'ellipse' } });
		expect(store.state.objects[n.id]?.clip.shape).toBe('ellipse');
	});

	it('set_clip on a locked object owned by another is denied', async () => {
		const store = makeStore(`r${String(Math.random())}`, BOB);
		const n = note(ALICE, 0, 'none');
		await store.commit({ kind: 'create_object', object: n });
		await expect(
			store.commit({ kind: 'set_clip', id: n.id, clip: { shape: 'circle' } })
		).rejects.toMatchObject({ reason: 'permission' });
	});
});

describe('emotes (UX-AV-5/7)', () => {
	it('set_hand / set_away change your OWN participant', async () => {
		const room = `r${String(Math.random())}`;
		const store = makeStore(room, ALICE);
		await store.commit({ kind: 'upsert_participant', participant: person(ALICE) });
		await store.commit({ kind: 'set_hand', id: ALICE, raised: true });
		await store.commit({ kind: 'set_away', id: ALICE, away: true });
		expect(store.state.participants[ALICE]?.raised_hand).toBe(true);
		expect(store.state.participants[ALICE]?.away).toBe(true);
	});

	it('you cannot emote someone else (UX-AV-7 self-only)', async () => {
		const room = `r${String(Math.random())}`;
		const store = makeStore(room, BOB);
		await store.commit({ kind: 'upsert_participant', participant: person(ALICE) });
		await expect(
			store.commit({ kind: 'set_hand', id: ALICE, raised: true })
		).rejects.toMatchObject({ reason: 'permission' });
	});
});

describe('room title/description (UX-ROOM-2)', () => {
	it('set_room_meta updates shared title and description', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		await store.commit({ kind: 'set_room_meta', title: 'Standup', description: 'daily sync' });
		expect(store.state.title).toBe('Standup');
		expect(store.state.description).toBe('daily sync');
	});
});

describe('configurations (UX-ROOM-3..6) — snapshot model', () => {
	it('save captures layout; switch/reset restore per-config transforms', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const n = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object: n });
		const cfg = '99999999-9999-4999-8999-999999999999';
		await store.commit({ kind: 'save_config', id: cfg, name: 'A' });
		expect(store.state.active_config).toBe(cfg);

		// Move the note, then switch back to config A — layout restored.
		await store.commit({ kind: 'move_object', id: n.id, transform: { ...n.transform, x: 500 } });
		expect(store.state.objects[n.id]?.transform.x).toBe(500);
		await store.commit({ kind: 'switch_config', id: cfg });
		expect(store.state.objects[n.id]?.transform.x).toBe(0);

		// Reset re-applies the active snapshot (UX-ROOM-5).
		await store.commit({ kind: 'move_object', id: n.id, transform: { ...n.transform, x: 700 } });
		await store.commit({ kind: 'reset_config' });
		expect(store.state.objects[n.id]?.transform.x).toBe(0);
	});

	it('switching restores per-config background/title; content persists', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const n = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object: n });
		await store.commit({ kind: 'set_room_meta', title: 'A', description: '' });
		await store.commit({ kind: 'save_config', id: '11111111-1111-4111-8111-aaaaaaaaaaaa', name: 'ConfA' });
		await store.commit({ kind: 'set_room_meta', title: 'B', description: '' });
		await store.commit({ kind: 'edit_note', id: n.id, payload: { text: 'kept' } });
		await store.commit({ kind: 'switch_config', id: '11111111-1111-4111-8111-aaaaaaaaaaaa' });
		expect(store.state.title).toBe('A'); // layout/meta restored
		expect(store.state.objects[n.id]?.type === 'note' && store.state.objects[n.id]?.payload).toBeTruthy();
		const obj = store.state.objects[n.id];
		if (obj?.type === 'note') expect(obj.payload.text).toBe('kept'); // content persisted
	});

	it('delete removes a config and clears active if it was active', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const cfg = '22222222-2222-4222-8222-bbbbbbbbbbbb';
		await store.commit({ kind: 'save_config', id: cfg, name: 'X' });
		await store.commit({ kind: 'delete_config', id: cfg });
		expect(store.state.configurations[cfg]).toBeUndefined();
		expect(store.state.active_config).toBeNull();
	});
});

describe('avatars are canvas objects too (UX-AV-1)', () => {
	it('resizes and rotates your own avatar', async () => {
		const room = `r${String(Math.random())}`;
		const store = makeStore(room, ALICE);
		await store.commit({ kind: 'upsert_participant', participant: person(ALICE) });
		await store.commit({
			kind: 'size_participant',
			id: ALICE,
			location: { x: 0, y: 0 },
			size: { width: 160, height: 120 },
			rotation: 30
		});
		expect(store.state.participants[ALICE]?.size).toEqual({ width: 160, height: 120 });
		expect(store.state.participants[ALICE]?.rotation).toBe(30);
	});

	it('reshapes your own avatar', async () => {
		const room = `r${String(Math.random())}`;
		const store = makeStore(room, ALICE);
		await store.commit({ kind: 'upsert_participant', participant: person(ALICE) });
		await store.commit({ kind: 'set_participant_clip', id: ALICE, clip: { shape: 'ellipse' } });
		expect(store.state.participants[ALICE]?.clip).toEqual({ shape: 'ellipse' });
	});

	it("refuses to resize or reshape SOMEONE ELSE's avatar", async () => {
		// Same self-only rule as emotes (UX-AV-7): your representation is yours.
		const room = `r${String(Math.random())}`;
		const store = makeStore(room, BOB);
		await store.commit({ kind: 'upsert_participant', participant: person(ALICE) });
		await expect(
			store.commit({
				kind: 'size_participant',
				id: ALICE,
				location: { x: 0, y: 0 },
				size: { width: 200, height: 200 },
				rotation: 0
			})
		).rejects.toMatchObject({ reason: 'permission' });
		await expect(
			store.commit({ kind: 'set_participant_clip', id: ALICE, clip: { shape: 'rect' } })
		).rejects.toMatchObject({ reason: 'permission' });
	});

	it('a resized avatar collides at its NEW size, not the default', async () => {
		// shapeOfParticipant used to hard-code AVATAR_SIZE, which would have let
		// a grown avatar overlap content it visually covers.
		const room = `r${String(Math.random())}`;
		const store = makeStore(room, ALICE);
		await store.commit({ kind: 'upsert_participant', participant: person(ALICE) });
		// A note just clear of a default 96px avatar at the origin.
		const neighbor = note(ALICE, 220);
		await store.commit({ kind: 'create_object', object: neighbor });
		const settled = store.state.objects[neighbor.id];
		expect(settled).toBeDefined();
		// Growing the avatar across that gap must be rejected as an overlap.
		await expect(
			store.commit({
				kind: 'size_participant',
				id: ALICE,
				location: { x: 0, y: 0 },
				size: { width: 400, height: 400 },
				rotation: 0
			})
		).rejects.toMatchObject({ reason: 'overlap' });
	});
});

describe('drawings are exempt from collision (UX-OBJ-12)', () => {
	const drawing = (creator: string, x: number): CanvasObject => {
		const transform = { x, y: 0, width: 100, height: 100, rotation: 0, z: 1 };
		return {
			id: uuid(),
			type: 'drawing',
			creator_id: creator,
			permission: 'all',
			transform,
			clip: { shape: 'rect' },
			border: { width: 0 },
			default_transform: transform,
			payload: { color: '#e11d48', width: 3, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] },
			created_at: '2026-07-18T00:00:00.000Z',
			updated_at: '2026-07-18T00:00:00.000Z'
		};
	};

	it('a new stroke stays exactly where it was drawn', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const blocker = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object: blocker });
		// Drawn right on top of the note: no relocation.
		const ink = drawing(ALICE, 0);
		await store.commit({ kind: 'create_object', object: ink });
		expect(store.state.objects[ink.id]?.transform.x).toBe(0);
		expect(store.state.objects[ink.id]?.transform.y).toBe(0);
	});

	it('a drawing may be moved onto content without rejection', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const blocker = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object: blocker });
		const ink = drawing(ALICE, 400);
		await store.commit({ kind: 'create_object', object: ink });
		await store.commit({
			kind: 'move_object',
			id: ink.id,
			transform: { ...ink.transform, x: 10, y: 10 }
		});
		expect(store.state.objects[ink.id]?.transform.x).toBe(10);
	});

	it('and does not obstruct anything else', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const ink = drawing(ALICE, 0);
		await store.commit({ kind: 'create_object', object: ink });
		// A note placed over the ink is NOT relocated: the ink is invisible to
		// the solver, so nearestLegal has nothing to avoid.
		const over = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object: over });
		expect(store.state.objects[over.id]?.transform.x).toBe(0);
	});
});
