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
 * Wait until the app has hydrated and its controls actually respond.
 *
 * SSR puts every control in the DOM before its handler exists, so clicking too
 * early is a no-op that looks like a broken feature. `joinRoom` gets this for
 * free by waiting on the canvas; document pages need to ask.
 */
export async function hydrated(page: Page): Promise<void> {
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
}
