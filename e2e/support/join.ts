import { expect, type Page } from '@playwright/test';
import { createRoomDirectly } from './auth';

/**
 * Enter a room, answering the join prompt if it appears.
 *
 * UX-ID-1 requires a name before joining, so every room visit now starts with
 * a prompt on a fresh browser. Identity is stored per browser context, so only
 * the first page in a context sees it — which is why this checks rather than
 * assuming, and why it works unchanged for the many two-page tests where the
 * second page inherits the first's identity.
 *
 * Centralised deliberately: a per-test copy of this would be ~20 copies of a
 * rule that is going to keep changing.
 */
export async function joinRoom(page: Page, room: string, name = 'Tester'): Promise<void> {
	// The room has to EXIST now. On the stub, visiting a URL conjured a room in
	// localStorage; against Postgres the route 404s one that was never created.
	//
	// Created out-of-band rather than through /new on purpose: going through the
	// UI would make this browser an account holder AND the room's host, which is
	// the opposite of the case these tests cover (UX-ROOM-11 — joining needs no
	// account). This way the browser stays an anonymous GUEST and the guest path
	// keeps its coverage. Idempotent, so the second page of a two-page test can
	// call it for the same room.
	await createRoomDirectly(room);

	await page.goto(`/hey/${room}`);

	const nameField = page.getByRole('textbox', { name: 'Your name' });
	const canvas = page.getByRole('application', { name: 'Room canvas' });

	// Wait for ONE of the two outcomes before deciding which happened.
	// `isVisible()` does not wait, so checking it directly is a race: under
	// parallel workers the check ran before the dialog rendered, the prompt
	// went unanswered, and the canvas never appeared. Sequentially it passed
	// every time, which is exactly how this kind of flake hides.
	await expect(nameField.or(canvas).first()).toBeVisible();

	if (await nameField.isVisible()) {
		await nameField.fill(name);
		await page.getByRole('button', { name: 'Join' }).click();
	}

	await expect(canvas).toBeVisible();
}

/**
 * How long a change may take to reach ANOTHER client.
 *
 * Playwright's default assertion budget is 5s, which was ample when the store
 * was in-memory and a peer saw a change in the same tick. A cross-client
 * assertion now spans a write to Postgres, a Realtime broadcast, and the
 * receiver's re-read — the broadcast carries a version, not the state
 * (supabase-store.svelte.ts), so it is two hops, not one. 5s is a thin margin
 * for that, and this is the honest budget for it.
 *
 * What this is NOT: a fix for the suite's remaining flakiness under parallel
 * workers. That was the hypothesis, and measurement refuted it — widening these
 * assertions changed the failure rate not at all, and raising Playwright's
 * global `expect` timeout to the same value changed it not at all either, so
 * that global raise was reverted rather than left in as a change nothing
 * supports. The residual flakiness is documented as unexplained rather than
 * papered over; see the notes in CONTROL-PLANE.md.
 *
 * Named rather than written inline, because `{ timeout: 10_000 }` scattered
 * through the specs reads as superstition. It applies ONLY where one page
 * observes what another did; a same-page assertion needing ten seconds is a
 * bug, and giving it this budget would hide one.
 */
export const SYNC = 10_000;

/** A room name unique to this test run. */
export function roomName(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/**
 * Wait until the camera has stopped moving.
 *
 * Adding content re-runs auto-fit, which ANIMATES the world layer for ~300ms
 * (Viewport.markAnimated). A test that measures a boundingBox and then clicks
 * it is aiming at a moving target: it usually wins the race and occasionally
 * does not, which is precisely the flake CI reported for the placer selection
 * test. Waiting on the transform settling is deterministic where a fixed sleep
 * is just a longer bet.
 */
export async function cameraSettled(page: Page): Promise<void> {
	const world = page.locator('.world');
	let previous = '';
	await expect
		.poll(
			async () => {
				const current = await world.evaluate((el) =>
					el instanceof HTMLElement ? el.style.transform : ''
				);
				const stable = current !== '' && current === previous;
				previous = current;
				return stable;
			},
			{ intervals: [100, 100, 100, 100, 100, 100] }
		)
		.toBe(true);
}

/**
 * Wait until every commit has been confirmed by the server.
 *
 * The counterpart to `cameraSettled` for WRITES. Tests used to approximate
 * this with `waitForTimeout(400)`, which was a reasonable bet when a commit was
 * a synchronous localStorage write and is a coin toss now that it is a network
 * round trip. Losing that toss is not a slow failure: the debounced commit
 * lands AFTER the assertion that depended on it, so the wrong value is already
 * written and no amount of extra timeout recovers it.
 *
 * Reads `data-syncing`, set by the room page from the store's in-flight count,
 * exactly as `data-hydrated` is set by the layout.
 */
export async function settled(page: Page): Promise<void> {
	await expect(page.locator('html')).toHaveAttribute('data-syncing', 'false', { timeout: SYNC });
}

/**
 * Wait until the app has hydrated and its controls actually respond.
 *
 * SSR puts every control in the DOM before its handler exists, so clicking too
 * early is a no-op that looks like a broken feature. `joinRoom` gets this for
 * free by waiting on the canvas; document pages need to ask.
 */
export async function hydrated(page: Page): Promise<void> {
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
}
