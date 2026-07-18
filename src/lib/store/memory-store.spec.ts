import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRoomStore } from './memory-store.svelte';
import { StoreRejection } from '$lib/model/types';
import type { CanvasObject } from '$lib/model/types';

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
