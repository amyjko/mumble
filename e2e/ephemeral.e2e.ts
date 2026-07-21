import { expect, test, type Locator } from '@playwright/test';
import { cameraSettled, SYNC, joinRoom, roomName } from './support/join';

/**
 * The two sync classes nothing had ever tested ACROSS clients (AR-SYNC-1,
 * UX-QOS-3).
 *
 * AR-SYNC-1 splits shared state into four classes with one path each, and two
 * of them ride Broadcast with no database in the hot path: "ephemeral shared"
 * (drag-in-progress deltas) and "fire-and-forget events" (transient
 * reactions). Both were built, and both were asserted only within a single
 * page — which proves the local optimistic update and nothing about delivery.
 * UX-QOS-3 says presence-type events "appear near-instantly for everyone", and
 * "for everyone" is precisely the untested word.
 *
 * Why these tests are hard to fake, and why they live in separate CONTEXTS:
 * identity is per-browser, so two pages in one context are one participant
 * with two sockets. Two contexts are two people, which is what the
 * requirements are about. It also means the assertions cannot pass off a local
 * echo as delivery — the reacting avatar in B is a REMOTE participant that B
 * only knows about through the room at all.
 *
 * These deliberately do not touch the persisted class. A raised hand looks
 * like an ephemeral signal and is not one (it is the slot queue, in Postgres),
 * which is exactly the confusion that let this gap survive: emote.e2e.ts
 * appeared to cover reactions and covers the queue.
 */

const transformOf = async (target: Locator): Promise<string> =>
	target.evaluate((el) => (el instanceof HTMLElement ? el.style.transform : ''));

/**
 * Fire-and-forget (AR-SYNC-1 class 3, UX-AV-4, UX-QOS-3).
 *
 * A reaction is never stored and never acknowledged, so the ONLY evidence it
 * works between people is seeing one arrive. It expires on its own ~1.6s
 * timer, which is why this polls for the float rather than asserting once:
 * the assertion has to win a race against the animation it is watching.
 */
test('a reaction reaches another client (UX-QOS-3)', async ({ browser }) => {
	const room = roomName('react');
	const reactor = await browser.newContext();
	const watcher = await browser.newContext();
	const a = await reactor.newPage();
	const b = await watcher.newPage();

	await joinRoom(a, room, 'Reactor');
	await joinRoom(b, room, 'Watcher');

	// B must know A exists before A reacts, or the reaction arrives addressed
	// to a participant B cannot draw and vanishes with nothing to show for it.
	await expect(b.locator('.avatar')).toHaveCount(2, { timeout: SYNC });

	// Reactions are self-initiated (UX-AV-7), so this is A reacting on A.
	await a.getByRole('button', { name: 'Celebrate' }).click();

	// ...and it floats above A's avatar in B's window, which is the whole claim.
	await expect(b.locator('.avatar .float')).toHaveCount(1, { timeout: SYNC });

	await reactor.close();
	await watcher.close();
});

/**
 * Ephemeral shared (AR-SYNC-1 class 2, UX-QOS-2, AR-BACKEND-5).
 *
 * The distinguishing assertion is MID-GESTURE: the pointer is still down, so
 * nothing has been committed and no persisted broadcast has happened. If B
 * moves here, it moved because a drag delta crossed the ephemeral channel —
 * the one path AR-BACKEND-5 throttles to ~20 Hz. Asserting after the drop
 * would prove only that Postgres works, which mutate.e2e.ts already covers.
 *
 * What this proves, stated exactly, because it was measured rather than
 * assumed: DELIVERY. Deleting the `drag_participant` case makes it fail.
 * Deleting only the SMOOTHING does not — the first delta is applied on arrival
 * by design, so a peer's object never waits a frame to appear. Interpolation
 * itself is covered where it can be asserted precisely, on intermediate
 * positions with a hand-cranked clock, in sync-client.spec.ts.
 */
test('a drag in progress reaches another client before it is committed', async ({ browser }) => {
	const room = roomName('dragsync');
	const dragger = await browser.newContext();
	const watcher = await browser.newContext();
	const a = await dragger.newPage();
	const b = await watcher.newPage();

	await joinRoom(a, room, 'Dragger');
	await joinRoom(b, room, 'Watcher');

	/*
	 * An AVATAR, not an object, and that is not arbitrary.
	 *
	 * The first version dragged a timer from its centre — which is where the
	 * timer's own start/reset controls live, and those call `stopPointer` so a
	 * press on them deliberately does NOT begin a drag. It therefore depended
	 * on where the controls happened to sit, and failed most of the time with
	 * the object simply never having moved. An avatar's centre is its face,
	 * with the handles at its edges, so a press there always drags.
	 *
	 * The class under test is the same either way: `drag_participant` and
	 * `drag_object` are both AR-SYNC-1's ephemeral class on one channel.
	 */
	const mine = a.locator('.avatar').filter({ hasText: 'Dragger' });
	const watched = b.locator('.avatar').filter({ hasText: 'Dragger' });
	await expect(watched).toHaveCount(1, { timeout: SYNC });

	/*
	 * Wait for A's CAMERA before measuring anything. B joining puts a second
	 * avatar on A's canvas, which re-runs auto-fit — and auto-fit ANIMATES for
	 * ~300ms. Measuring a bounding box during that aims at a moving target: the
	 * press lands beside the avatar instead of on it and no drag begins.
	 */
	await expect(a.locator('.avatar')).toHaveCount(2, { timeout: SYNC });
	await cameraSettled(a);

	const before = await transformOf(watched);
	const box = await mine.boundingBox();
	if (box === null) throw new Error('the avatar has no box');

	// Steps matter: one jump is a single pointermove, and the throttle may
	// legitimately swallow it. A stepped move is a stream, which is what the
	// ephemeral class actually carries.
	await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await a.mouse.down();
	await a.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 140, { steps: 12 });

	try {
		// A's own drag must actually be happening, or the rest asserts nothing.
		await expect.poll(async () => transformOf(mine), { timeout: SYNC }).not.toBe(before);
		// Still held. Nothing is committed, so any movement in B is ephemeral.
		await expect.poll(async () => transformOf(watched), { timeout: SYNC }).not.toBe(before);
	} finally {
		// Release even if the assertion fails, or the next test inherits a
		// button that is still down.
		await a.mouse.up();
	}

	await dragger.close();
	await watcher.close();
});
