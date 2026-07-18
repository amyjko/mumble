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
