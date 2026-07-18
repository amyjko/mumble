import { afterEach, describe, expect, it, vi } from 'vitest';
import { AVATAR_SIZE, CHAT_LOG_LIMIT, MemoryRoomStore } from './memory-store.svelte';
import { StoreRejection } from '$lib/model/types';
import type { CanvasObject, Participant } from '$lib/model/types';
import { docFromEncoded, encodeDoc, encodedFromText, noteText, textType } from '$lib/model/ydoc';

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
		hidden: false,
		payload: { text: '', doc: '' },
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
	away: false,
	muted: true
});

/** Chat fixture usable from any describe (the other one is block-scoped). */
const chatObject = (creator: string): CanvasObject => {
	const transform = { x: 0, y: 0, width: 280, height: 220, rotation: 0, z: 1 };
	return {
		id: uuid(),
		type: 'chat',
		creator_id: creator,
		permission: 'all',
		transform,
		clip: { shape: 'rounded', radius: 8 },
		border: { width: 10 },
		hidden: false,
		payload: { messages: [] },
		created_at: '2026-07-18T00:00:00.000Z',
		updated_at: '2026-07-18T00:00:00.000Z'
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
			hidden: false,
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
			store.commit({ kind: 'edit_note', id: t.id, update: encodedFromText('x') })
		).rejects.toMatchObject({ reason: 'invalid' });
	});
});

describe('chat object (UX-OBJ-3) — retained log, open posting', () => {
	const chat = (creator: string, permission: 'all' | 'none' = 'all') => {
		const transform = { x: 0, y: 0, width: 280, height: 220, rotation: 0, z: 1 };
		return {
			id: uuid(), type: 'chat' as const, creator_id: creator, permission,
			transform, clip: { shape: 'rounded' as const, radius: 8 }, border: { width: 10 },
			hidden: false, payload: { messages: [] },
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
		expect(store.state.queue).toContain(ALICE); // raise-hand IS the queue entry
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
		await store.commit({ kind: 'edit_note', id: n.id, update: encodedFromText('kept') });
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
			hidden: false,
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

describe('object visibility (UX-ROOM-3)', () => {
	it('hiding keeps the object; it is not a delete', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const object = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object });
		await store.commit({ kind: 'set_hidden', id: object.id, hidden: true });
		expect(store.state.objects[object.id]).toBeDefined();
		expect(store.state.objects[object.id]?.hidden).toBe(true);
	});

	it('a hidden object stops occupying space', async () => {
		// An obstacle nobody can see is worse than an overlap: the space a
		// hidden object held must be reusable.
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const first = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object: first });
		await store.commit({ kind: 'set_hidden', id: first.id, hidden: true });

		// A second note placed exactly on top is NOT relocated.
		const second = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object: second });
		expect(store.state.objects[second.id]?.transform.x).toBe(0);
	});

	it('unhiding relocates to a legal spot rather than overlapping', async () => {
		// The mirror of the rule above: while hidden the object was excluded
		// from occupancy, so its old spot may have been taken in the meantime.
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const first = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object: first });
		await store.commit({ kind: 'set_hidden', id: first.id, hidden: true });
		const second = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object: second });

		await store.commit({ kind: 'set_hidden', id: first.id, hidden: false });
		const revealed = store.state.objects[first.id];
		const other = store.state.objects[second.id];
		expect(revealed).toBeDefined();
		expect(other).toBeDefined();
		if (revealed === undefined || other === undefined) return;
		expect(revealed.hidden).toBe(false);
		// It moved out of the way instead of landing on top of the newcomer.
		const overlapping = revealed.transform.x === other.transform.x && revealed.transform.y === other.transform.y;
		expect(overlapping).toBe(false);
	});
});

describe('configurations carry visibility (UX-ROOM-3/5)', () => {
	it('a layout is position, size, AND visibility', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const object = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object });

		// Save a configuration with the object visible.
		await store.commit({ kind: 'save_config', id: uuid(), name: 'Visible' });

		// Hide it and save a second configuration.
		await store.commit({ kind: 'set_hidden', id: object.id, hidden: true });
		const hiddenConfig = uuid();
		await store.commit({ kind: 'save_config', id: hiddenConfig, name: 'Hidden' });

		// Switching back and forth restores visibility along with layout.
		const first = Object.values(store.state.configurations).find((c) => c.name === 'Visible');
		expect(first).toBeDefined();
		if (first === undefined) return;
		await store.commit({ kind: 'switch_config', id: first.id });
		expect(store.state.objects[object.id]?.hidden).toBe(false);

		await store.commit({ kind: 'switch_config', id: hiddenConfig });
		expect(store.state.objects[object.id]?.hidden).toBe(true);
	});

	it('switching never touches CONTENT (UX-ROOM-5)', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const object = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object });
		const configId = uuid();
		await store.commit({ kind: 'save_config', id: configId, name: 'Start' });

		await store.commit({ kind: 'edit_note', id: object.id, update: encodedFromText('written later') });
		await store.commit({ kind: 'switch_config', id: configId });

		const settled = store.state.objects[object.id];
		expect(settled?.type).toBe('note');
		if (settled?.type !== 'note') return;
		expect(settled.payload.text).toBe('written later');
	});
});

describe('note editing is a CRDT (AR-SYNC-4)', () => {
	it('an update merges into the note rather than replacing it', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const object = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object });

		// Seed some text, then apply an independent edit built on that base.
		const base = encodedFromText('hello');
		await store.commit({ kind: 'edit_note', id: object.id, update: base });
		const settled = store.state.objects[object.id];
		expect(settled?.type).toBe('note');
		if (settled?.type !== 'note') return;
		expect(settled.payload.text).toBe('hello');

		const doc = docFromEncoded(settled.payload.doc);
		textType(doc).insert(textType(doc).length, ' world');
		await store.commit({ kind: 'edit_note', id: object.id, update: encodeDoc(doc) });

		const after = store.state.objects[object.id];
		expect(after?.type).toBe('note');
		if (after?.type !== 'note') return;
		expect(after.payload.text).toBe('hello world');
	});

	it('keeps the materialized text in step with the document', async () => {
		// `text` exists so the rest of the app never decodes a CRDT; it must
		// therefore never drift from `doc`.
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const object = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object });
		await store.commit({ kind: 'edit_note', id: object.id, update: encodedFromText('in step') });

		const settled = store.state.objects[object.id];
		if (settled?.type !== 'note') throw new Error('expected a note');
		expect(settled.payload.text).toBe(noteText(docFromEncoded(settled.payload.doc)));
	});

	it('rejects a malformed update', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const object = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object });
		await expect(
			store.commit({ kind: 'edit_note', id: object.id, update: 'definitely not base64 !!' })
		).rejects.toMatchObject({ reason: 'invalid' });
	});

	it("still refuses an edit to someone else's locked note (UX-PERM-1)", async () => {
		// Permission is checked once per mutation, at the boundary — the CRDT
		// changes what an edit CARRIES, not who may make one.
		const store = makeStore(`r${String(Math.random())}`, BOB);
		const locked = note(ALICE, 0, 'none');
		await store.commit({ kind: 'create_object', object: locked });
		await expect(
			store.commit({ kind: 'edit_note', id: locked.id, update: encodedFromText('nope') })
		).rejects.toMatchObject({ reason: 'permission' });
	});
});

describe('chat retention is bounded ONLY in the stub (UX-OBJ-3 deviation)', () => {
	it('counts what it evicts instead of dropping it silently', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const c = chatObject(ALICE);
		await store.commit({ kind: 'create_object', object: c });
		for (let i = 0; i < CHAT_LOG_LIMIT + 3; i++) {
			await store.commit({
				kind: 'post_message',
				id: c.id,
				message: {
					id: uuid(),
					author_id: ALICE,
					author_name: 'a',
					text: `m${String(i)}`,
					at: '2026-07-18T00:00:00.000Z'
				}
			});
		}
		const got = store.state.objects[c.id];
		expect(got?.type).toBe('chat');
		if (got?.type !== 'chat') return;
		expect(got.payload.messages).toHaveLength(CHAT_LOG_LIMIT);
		// The oldest are gone — and the store SAYS so, which is the whole point:
		// UX-OBJ-3 promises retention, so a silent cap is a lie by omission.
		expect(store.droppedChatMessages).toBe(3);
		expect(got.payload.messages[0]?.text).toBe('m3');
	});
});

describe('object permission is settable (UX-PERM-1)', () => {
	it('the creator can lock an object, and the lock then bites', async () => {
		// The enum, canEdit, and its spec all existed; nothing could SET it, so
		// the `host` and `none` branches had never run in the product.
		const room = `r${String(Math.random())}`;
		const alice = makeStore(room, ALICE);
		const object = note(ALICE, 0);
		await alice.commit({ kind: 'create_object', object });
		await alice.commit({ kind: 'set_permission', id: object.id, permission: 'none' });
		expect(alice.state.objects[object.id]?.permission).toBe('none');

		const bob = makeStore(room, BOB);
		await vi.waitFor(() => {
			expect(bob.state.objects[object.id]?.permission).toBe('none');
		});
		await expect(
			bob.commit({ kind: 'move_object', id: object.id, transform: { ...object.transform, x: 400 } })
		).rejects.toMatchObject({ reason: 'permission' });
	});

	it('a non-creator cannot change who may edit', async () => {
		// Not requireEditable: with 'all', anyone can edit the object, and
		// letting them re-lock it would let a passer-by take it from its creator.
		const room = `r${String(Math.random())}`;
		const alice = makeStore(room, ALICE);
		const object = note(ALICE, 0);
		await alice.commit({ kind: 'create_object', object });

		const bob = makeStore(room, BOB);
		await vi.waitFor(() => {
			expect(bob.state.objects[object.id]).toBeDefined();
		});
		await expect(
			bob.commit({ kind: 'set_permission', id: object.id, permission: 'none' })
		).rejects.toMatchObject({ reason: 'permission' });
	});
});

describe('creation permission is a room setting (UX-OBJ-9)', () => {
	it('defaults to all-may-create', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		expect(store.state.create_permission).toBe('all');
		await expect(store.commit({ kind: 'create_object', object: note(ALICE, 0) })).resolves.toBeUndefined();
	});

	it('host-only refuses creation — including, today, by everyone', async () => {
		// Enforced honestly: the host role arrives with admission, so a
		// host-only room currently admits nobody. Quietly allowing everyone
		// would make the setting a lie; the UI warns instead.
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		await store.commit({ kind: 'set_room_create_permission', value: 'host' });
		await expect(
			store.commit({ kind: 'create_object', object: note(ALICE, 200) })
		).rejects.toMatchObject({ reason: 'permission' });
	});
});

describe('sticker border is settable (UX-OBJ-8) and IS the overlap tolerance (UX-OBJ-12)', () => {
	it('new objects inherit the room default', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		expect(store.state.border_default).toBe(10);
		await store.commit({ kind: 'set_room_border', width: 24 });
		expect(store.state.border_default).toBe(24);
	});

	it('widening a border is always allowed — it shrinks the content', async () => {
		// More border means LESS content, so it can never create an overlap.
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const a = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object: a });
		await store.commit({ kind: 'set_border', id: a.id, width: 30 });
		expect(store.state.objects[a.id]?.border.width).toBe(30);
	});

	it('narrowing a border can be REFUSED, because content grows into a neighbour', async () => {
		// Two notes placed exactly at their tolerance: contents touch. Dropping
		// one border to zero expands that object's content by 10px on every
		// side, which is an overlap — the same rule a move obeys.
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const a = note(ALICE, 0); // 100 wide, border 10
		const b = note(ALICE, 80); // contents touch at x = 90
		await store.commit({ kind: 'create_object', object: a });
		await store.commit({ kind: 'create_object', object: b });
		// Only proceed if the store actually placed them adjacently.
		const placedB = store.state.objects[b.id];
		expect(placedB).toBeDefined();

		await expect(store.commit({ kind: 'set_border', id: a.id, width: 0 })).rejects.toMatchObject({
			reason: 'overlap'
		});
		expect(store.state.objects[a.id]?.border.width).toBe(10);
	});

	it('a border change obeys edit permission, not creator-only', async () => {
		// UX-OBJ-8 says the override is "subject to edit permission" — so unlike
		// set_permission (creator-only), a peer with edit rights may do it.
		const room = `r${String(Math.random())}`;
		const alice = makeStore(room, ALICE);
		const locked = note(ALICE, 0, 'none');
		await alice.commit({ kind: 'create_object', object: locked });

		const bob = makeStore(room, BOB);
		await vi.waitFor(() => {
			expect(bob.state.objects[locked.id]).toBeDefined();
		});
		await expect(bob.commit({ kind: 'set_border', id: locked.id, width: 20 })).rejects.toMatchObject({
			reason: 'permission'
		});
	});
});

describe('configurations can be edited (UX-ROOM-4/6)', () => {
	it('update rewrites the ACTIVE configuration in place', async () => {
		// Before this, "save" always minted a new id, so a configuration could
		// never be corrected — only duplicated.
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const object = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object });
		const id = uuid();
		await store.commit({ kind: 'save_config', id, name: 'Start' });

		// Move the object, then update the same configuration.
		await store.commit({
			kind: 'move_object',
			id: object.id,
			transform: { ...object.transform, x: 400 }
		});
		await store.commit({ kind: 'update_config' });

		expect(Object.keys(store.state.configurations)).toHaveLength(1);
		expect(store.state.configurations[id]?.snapshot.layouts[object.id]?.transform.x).toBe(400);
	});

	it('refuses to update when no configuration is active (UX-ROOM-4)', async () => {
		// "Editing a configuration requires being switched to it" — there is no
		// coherent target otherwise.
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		await expect(store.commit({ kind: 'update_config' })).rejects.toMatchObject({ reason: 'invalid' });
	});

	it('renames without disturbing the snapshot', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		const object = note(ALICE, 0);
		await store.commit({ kind: 'create_object', object });
		const id = uuid();
		await store.commit({ kind: 'save_config', id, name: 'Old' });
		await store.commit({ kind: 'rename_config', id, name: 'New' });
		expect(store.state.configurations[id]?.name).toBe('New');
		expect(store.state.configurations[id]?.snapshot.layouts[object.id]).toBeDefined();
	});
});

describe('the stage, through the store (UX-STAGE, AR-CTRL-2)', () => {
	const join = async (store: MemoryRoomStore, id: string): Promise<void> => {
		await store.commit({ kind: 'upsert_participant', participant: person(id) });
	};

	it('taking a slot is one call into the pure module', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		await join(store, ALICE);
		await store.commit({ kind: 'take_slot', id: ALICE, media: 'video' });
		expect(store.state.video_holders).toEqual([ALICE]);
	});

	it('you cannot take, release or mute on someone ELSE behalf', async () => {
		// Your slot and your mic are yours, the same self-only rule as emotes.
		const store = makeStore(`r${String(Math.random())}`, BOB);
		await join(store, ALICE);
		await expect(
			store.commit({ kind: 'take_slot', id: ALICE, media: 'video' })
		).rejects.toMatchObject({ reason: 'permission' });
		await expect(store.commit({ kind: 'set_muted', id: ALICE, muted: false })).rejects.toMatchObject({
			reason: 'permission'
		});
	});

	it('raise-hand IS the queue entry — there is no separate flag to drift', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		await join(store, ALICE);
		await store.commit({ kind: 'set_hand', id: ALICE, raised: true });
		expect(store.state.queue).toEqual([ALICE]);
		await store.commit({ kind: 'set_hand', id: ALICE, raised: false });
		expect(store.state.queue).toEqual([]);
	});

	it('leaving frees your slots and promotes the queue head', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		await join(store, ALICE);
		await store.commit({ kind: 'set_capacity', capacity: { max_participants: 10, max_av: 1, max_audio: 0 } });
		await store.commit({ kind: 'take_slot', id: ALICE, media: 'video' });
		// Someone else is waiting.
		await store.commit({ kind: 'upsert_participant', participant: person(BOB) });
		expect(store.state.video_holders).toEqual([ALICE]);

		await store.commit({ kind: 'remove_participant', id: ALICE });
		expect(store.state.video_holders).toEqual([]);
	});

	it('admission is refused once the room is full (UX-STAGE-11)', async () => {
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		await store.commit({ kind: 'set_capacity', capacity: { max_participants: 1, max_av: 1, max_audio: 1 } });
		await join(store, ALICE);
		await expect(
			store.commit({ kind: 'upsert_participant', participant: person(BOB) })
		).rejects.toMatchObject({ reason: 'permission' });

		// ...but re-upserting someone already present is never refused, or a
		// simple reconnect would lock you out of your own room.
		await expect(join(store, ALICE)).resolves.toBeUndefined();
	});

	it('a configuration switch re-applies its capacity and trims holders', async () => {
		// AR-MEDIA-1: caps are re-read on switch, and lowering one releases
		// holders beyond it. Configurations carry the numbers (UX-STAGE-1).
		const store = makeStore(`r${String(Math.random())}`, ALICE);
		await join(store, ALICE);
		await store.commit({ kind: 'set_capacity', capacity: { max_participants: 10, max_av: 2, max_audio: 0 } });
		await store.commit({ kind: 'take_slot', id: ALICE, media: 'video' });

		const roomy = uuid();
		await store.commit({ kind: 'save_config', id: roomy, name: 'Roomy' });

		// A second configuration with no video slots at all.
		await store.commit({ kind: 'set_capacity', capacity: { max_participants: 10, max_av: 0, max_audio: 0 } });
		const silent = uuid();
		await store.commit({ kind: 'save_config', id: silent, name: 'Silent' });

		await store.commit({ kind: 'switch_config', id: roomy });
		expect(store.state.capacity.max_av).toBe(2);

		await store.commit({ kind: 'switch_config', id: silent });
		expect(store.state.capacity.max_av).toBe(0);
		expect(store.state.video_holders).toEqual([]); // trimmed, not left over-cap
	});
});
