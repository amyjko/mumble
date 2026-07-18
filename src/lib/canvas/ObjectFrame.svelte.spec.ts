import { describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ObjectFrame from './ObjectFrame.svelte';
import { MemoryRoomStore, shapeOfObject } from '$lib/store/memory-store.svelte';
import { SyncClient } from '$lib/store/sync-client.svelte';
import { Viewport } from './viewport.svelte';
import type { CanvasObject } from '$lib/model/types';

/**
 * THE WEEK-ONE DRAG SPIKE (TESTING.md §6): can Vitest browser mode drive our
 * pointer-capture drag against real layout? userEvent is provider-backed
 * (Playwright CDP), so input is trusted — pointerId is real and
 * setPointerCapture must work. If this suite cannot pass, the documented
 * fallback is moving drag coverage to Playwright E2E.
 */

const ACTOR = '11111111-1111-4111-8111-111111111111';

function note(x: number, y: number): CanvasObject {
	const transform = { x, y, width: 200, height: 160, rotation: 0, z: 1 };
	return {
		id: crypto.randomUUID(),
		type: 'note',
		creator_id: ACTOR,
		permission: 'all',
		transform,
		clip: { shape: 'rounded', radius: 8 },
		border: { width: 10 },
		default_transform: transform,
		hidden: false,
		payload: { text: '', doc: '' },
		created_at: '2026-07-17T00:00:00.000Z',
		updated_at: '2026-07-17T00:00:00.000Z'
	};
}

function harness(dragged: CanvasObject, obstacle: CanvasObject | null) {
	const store = new MemoryRoomStore(`spike-${crypto.randomUUID()}`, ACTOR);
	const sync = new SyncClient(store);
	const viewport = new Viewport(); // identity camera: world deltas == pixel deltas
	return {
		store,
		sync,
		props: {
			object: dragged,
			store,
			sync,
			viewport,
			identity: { id: ACTOR, name: 'tester', emoji: '🐢' },
			obstacles: () => (obstacle === null ? [] : [shapeOfObject(obstacle)]),
			onFullscreen: () => {}
		}
	};
}

function dropTarget(x: number, y: number): HTMLElement {
	const el = document.createElement('div');
	el.style.cssText = `position:fixed;left:${String(x)}px;top:${String(y)}px;width:12px;height:12px;z-index:99999;`;
	document.body.appendChild(el);
	return el;
}

describe('drag spike (pointer capture in browser mode)', () => {
	it('drags a free object and commits the move', async () => {
		const object = note(0, 0);
		const { store, sync, props } = harness(object, null);
		await store.commit({ kind: 'create_object', object });
		await render(ObjectFrame, props);

		const frame = page.getByRole('group', { name: /note/i });
		await expect.element(frame).toBeVisible();
		const before = frame.element().getBoundingClientRect();

		// Grab by the sticker edge: the content area is the textarea, and
		// [data-editable] correctly refuses to start a drag (that's the UX).
		const target = dropTarget(before.left + 340, before.top + 120);
		await userEvent.dragAndDrop(frame, page.elementLocator(target), {
			// Top edge MIDPOINT, not the corner: the corner resize handles are
			// 12px and overhang the frame by 4px, so a grab at (5,5) lands on
			// `nw` and resizes instead of dragging. (That only surfaced once the
			// design tokens were loaded into the test page and the handles got
			// their real size — before that they collapsed to zero width.)
			sourcePosition: { x: 100, y: 5 }
		});

		// The commit lands asynchronously (optimistic overlay first — AR-SYNC-2).
		await vi.waitFor(() => {
			const settled = store.state.objects[object.id];
			expect(settled).toBeDefined();
			expect(settled?.transform.x).toBeGreaterThan(150);
		});
		// No stuck optimistic state: the overlay cleared on confirmation.
		// (In the app the frame tracks store state via WorldCanvas; this harness
		// passes a static prop, so the DOM position is asserted in the app, not here.)
		expect(sync.objectOverlays.size).toBe(0);
		void before;
		store.dispose();
	});

	it('is constrained by a neighbor: stops at content contact (UX-OBJ-12)', async () => {
		const object = note(0, 0);
		const obstacle = note(300, 0);
		const { store, props } = harness(object, obstacle);
		await store.commit({ kind: 'create_object', object });
		await render(ObjectFrame, props);

		const frame = page.getByRole('group', { name: /note/i });
		await expect.element(frame).toBeVisible();
		const before = frame.element().getBoundingClientRect();

		// Try to drag well past the obstacle; contents (inset by border 10)
		// touch at x = 120, so the solver must clamp there.
		const target = dropTarget(before.left + 500, before.top + 4);
		await userEvent.dragAndDrop(frame, page.elementLocator(target), {
			// Top edge MIDPOINT, not the corner: the corner resize handles are
			// 12px and overhang the frame by 4px, so a grab at (5,5) lands on
			// `nw` and resizes instead of dragging. (That only surfaced once the
			// design tokens were loaded into the test page and the handles got
			// their real size — before that they collapsed to zero width.)
			sourcePosition: { x: 100, y: 5 }
		});

		await vi.waitFor(() => {
			const settled = store.state.objects[object.id];
			expect(settled).toBeDefined();
			expect(settled?.transform.x).toBeGreaterThan(60); // it moved…
			expect(settled?.transform.x).toBeLessThanOrEqual(121); // …and clamped
		});
		store.dispose();
	});

	it('store + sync construct inside $derived (the room-page pattern)', () => {
		// Regression: SyncClient subscribes in its constructor; if the store's
		// handler registry is reactive, constructing the pair inside $derived
		// throws state_unsafe_mutation and blanks the page. Reading `sync`
		// forces both deriveds to evaluate exactly as /hey/[room] does.
		const cleanup = $effect.root(() => {
			let room = $state('a');
			const store = $derived(new MemoryRoomStore(`drv-${room}-${crypto.randomUUID()}`, ACTOR));
			const sync = $derived(new SyncClient(store));
			expect(sync.objectOverlays.size).toBe(0);
			room = 'b';
			flushSync();
			expect(room).toBe('b'); // the reassignment flows into the derived below
			expect(sync.lastRejection).toBeNull();
			store.dispose();
		});
		cleanup();
	});

	it('renders real layout: getBoundingClientRect is non-zero (why not jsdom)', async () => {
		const object = note(40, 24);
		const { store, props } = harness(object, null);
		await render(ObjectFrame, props);
		const frame = page.getByRole('group', { name: /note/i });
		await expect.element(frame).toBeVisible();
		const rect = frame.element().getBoundingClientRect();
		expect(rect.width).toBe(200);
		expect(rect.height).toBe(160);
		store.dispose();
	});
});
