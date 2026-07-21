import { expect, test } from '@playwright/test';
import { cameraSettled, joinRoom, roomName } from './support/join';
import { adminClient, createRoomDirectly } from './support/auth';
import { MAX_ROOM_OBJECTS } from '../src/lib/model/limits';

/**
 * The object-count budget (AR-CANVAS-4).
 *
 * The requirement asks to "define and measure the object-count/drawing-
 * complexity budget on target devices; virtualize or rasterize static layers
 * past the ceiling", and its tag admitted none of that had happened: the only
 * frame-budget test in the project is
 * `canvas/geometry.spec.ts`'s, which times the COLLISION SOLVER in node and
 * says nothing about how many DOM nodes a room can carry.
 *
 * This measures the real thing — a real room, in workerd, with real objects,
 * dragging one while everything else is mounted — and asserts the ceiling the
 * measurement produced. `MAX_ROOM_OBJECTS` is that number; the comment beside
 * it records what was measured and when.
 *
 * WHAT THIS IS NOT: a benchmark. CI machines vary and a test that fails when a
 * runner is busy is a test people delete. The assertions are deliberately
 * generous — they catch an ORDER-of-magnitude regression (a render that became
 * quadratic, a reactive graph that recomputes every object per frame), not a
 * 20% drift. The numbers printed are the useful output; the thresholds only
 * stop the numbers rotting silently.
 */

/**
 * The two values the in-page frame recorder parks on `window`.
 *
 * Declared rather than asserted onto `window`: type assertions are banned in
 * this project, and `window as unknown as { … }` twice would have been two of
 * them in the one file whose job is to measure honestly.
 */
declare global {
	interface Window {
		__frames?: number[];
		__stopFrames?: () => void;
	}
}

/** Seeded straight into Postgres: N mutate round trips would dominate the timing. */
async function seedObjects(room: string, count: number): Promise<string> {
	const roomId = await createRoomDirectly(room);
	const now = new Date().toISOString();

	// A grid, so objects do not all pile on one another — overlap resolution and
	// z-ordering both behave differently in a heap than in a room-shaped layout,
	// and a heap would flatter the measurement.
	const columns = Math.ceil(Math.sqrt(count));
	const rows = Array.from({ length: count }, (_, i) => ({
		id: crypto.randomUUID(),
		room_id: roomId,
		type: 'note',
		creator_id: '00000000-0000-4000-8000-000000000000',
		permission: 'all',
		hidden: false,
		transform: {
			x: (i % columns) * 260,
			y: Math.floor(i / columns) * 220,
			width: 200,
			height: 160,
			rotation: 0,
			z: i + 1
		},
		clip: { shape: 'rounded', radius: 8 },
		border: { width: 6 },
		payload: { text: `note ${String(i)}`, doc: '' },
		created_at: now,
		updated_at: now
	}));

	const { error } = await adminClient().from('room_objects').insert(rows);
	if (error !== null) throw new Error(`could not seed ${String(count)} objects: ${error.message}`);
	return roomId;
}

/**
 * Frame intervals while dragging, in milliseconds.
 *
 * Measured with `requestAnimationFrame` inside the page rather than with
 * Playwright's clock: what matters is whether the BROWSER can produce frames
 * while the canvas re-renders, and a timer outside the page cannot see a frame
 * that was never painted.
 */
async function dragAndMeasure(page: import('@playwright/test').Page): Promise<number[]> {
	await page.evaluate(() => {
		window.__frames = [];
		let last = performance.now();
		let running = true;
		const tick = (): void => {
			if (!running) return;
			const now = performance.now();
			window.__frames?.push(now - last);
			last = now;
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
		window.__stopFrames = () => {
			running = false;
		};
	});

	// Drag the first note across the room: a real pointer gesture, so the whole
	// path runs — hit testing, the overlap solver, the reactive graph, and the
	// transform write per move.
	const first = page.getByRole('group', { name: /note/i }).first();
	const box = await first.boundingBox();
	if (box === null) throw new Error('no note to drag');
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	for (let step = 0; step < 24; step++) {
		await page.mouse.move(box.x + box.width / 2 + step * 6, box.y + box.height / 2 + step * 3);
	}
	await page.mouse.up();

	return page.evaluate(() => {
		window.__stopFrames?.();
		// Drop the first few: the gesture's first frame includes hit testing and
		// the pointer capture, which is a one-off cost and not what a budget is
		// about.
		return (window.__frames ?? []).slice(3);
	});
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** The 95th percentile — where a stutter actually lives. A median hides them. */
function p95(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

const COUNTS = [25, 100, MAX_ROOM_OBJECTS];

test('the object-count budget holds at its ceiling (AR-CANVAS-4)', async ({ page }) => {
	const measured: { count: number; median: number; p95: number; load: number }[] = [];

	for (const count of COUNTS) {
		const room = roomName(`budget${String(count)}`);
		await seedObjects(room, count);

		const started = Date.now();
		await joinRoom(page, room);
		await cameraSettled(page);
		const load = Date.now() - started;

		const frames = await dragAndMeasure(page);
		expect(frames.length).toBeGreaterThan(10);
		measured.push({ count, median: median(frames), p95: p95(frames), load });
	}

	// The useful output. Printed rather than asserted, because the NUMBERS are
	// what a future reader wants and a threshold is only a tripwire.
	console.log(
		'AR-CANVAS-4 measurements\n' +
			measured
				.map(
					(m) =>
						`  ${String(m.count).padStart(4)} objects: median ${m.median.toFixed(1)}ms, p95 ${m.p95.toFixed(1)}ms, load ${String(m.load)}ms`
				)
				.join('\n')
	);

	const ceiling = measured[measured.length - 1];
	expect(ceiling).toBeDefined();
	if (ceiling === undefined) return;

	/*
	 * Two frames' grace at 60Hz for the median, and four for p95 — against
	 * measured values of 11.0ms and 15.1ms at this count, so there is room for a
	 * busy CI runner before either trips.
	 *
	 * Generous on purpose — see the header. What this catches is the class of
	 * regression that turns a linear render into a quadratic one, where the
	 * number does not drift but multiplies. A room at the ceiling taking 100ms
	 * per frame is not a slow machine, it is a broken render.
	 *
	 * P95 IS THE ONE THAT MATTERS. The exploratory run past this ceiling found
	 * the median IMPROVING while the experience collapsed — 4.5ms median at 1600
	 * objects against a 48.7ms p95 — because most frames stay cheap and a few
	 * become catastrophic. A budget policed by medians would have called that
	 * room faster than an empty one.
	 */
	expect(ceiling.median).toBeLessThan(33);
	expect(ceiling.p95).toBeLessThan(67);

	/*
	 * And the ceiling must not cost more than linearly against the smallest
	 * room. This is the assertion that would actually fire on a quadratic
	 * regression, since absolute thresholds can absorb a lot before they trip.
	 */
	const smallest = measured[0];
	expect(smallest).toBeDefined();
	if (smallest === undefined) return;
	const growth = ceiling.median / Math.max(smallest.median, 1);
	expect(growth).toBeLessThan(4);
});
