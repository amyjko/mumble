import { expect, test } from '@playwright/test';
import { joinRoom, roomName, settled } from './support/join';
import { hostRoom } from './support/auth';

/**
 * Two browsers, one room, a real peer connection (AR-TRANSPORT-1, AR-CTRL-3).
 *
 * The cross-context proof, and deliberately the SMALLEST claim in the media
 * suite. Negotiation, the publish gate, collision handling and layer selection
 * are all asserted in the in-page transport tests, which use real peer
 * connections and run in seconds. What only an end-to-end test can show is that
 * signalling reaches the right peer through Supabase's RLS and that two
 * genuinely separate browser contexts connect.
 *
 * It asserts `data-media-peers`, in the idiom `data-syncing` and `data-hydrated`
 * already establish, rather than inspecting a `<video>`: nothing renders remote
 * media yet, and a test that waited for pixels would be waiting for a feature
 * that has not been built. When tiles land, this assertion stays true.
 *
 * What it CANNOT show is in AR-TEST-10: both contexts are on one machine, so
 * only host candidates are exercised, no TURN relay is involved, and the fake
 * capture device encodes far below any rung.
 */

/*
 * Generous, and for a specific reason: the default 30s is the whole test, and
 * signing in, creating a room, joining it and settling two clients spends most
 * of that before ICE has even started. A connection that took ten seconds was
 * being reported as a failure to connect at all.
 */
test.describe.configure({ timeout: 120_000 });

test('two participants establish a peer connection (AR-TRANSPORT-1)', async ({ browser }) => {
	const room = roomName('media');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	await hostRoom(host, room);
	await settled(host);

	// AR-CTRL-3: alone in the room, there is nobody to connect to and no camera
	// is ever requested. A lurker must not see a permission dialog.
	await expect(host.locator('html')).toHaveAttribute('data-media-peers', '0');

	await joinRoom(guest, room, 'Peer');
	await settled(guest);

	// Someone else is here now, so both sides pre-warm a connection — before
	// either has taken a slot (AR-TRANSPORT-9).
	await expect(host.locator('html')).toHaveAttribute('data-media-peers', '1', { timeout: 30_000 });
	await expect(guest.locator('html')).toHaveAttribute('data-media-peers', '1', { timeout: 30_000 });

	await hostCtx.close();
	await guestCtx.close();
});

test('a departing peer takes its connection with it', async ({ browser }) => {
	// The other half of the lifecycle: a connection that outlives the person it
	// was to would keep an encoder running and report a peer who has gone.
	const room = roomName('mediabye');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	await hostRoom(host, room);
	await settled(host);
	await joinRoom(guest, room, 'Leaving');
	await settled(guest);

	await expect(host.locator('html')).toHaveAttribute('data-media-peers', '1', { timeout: 30_000 });

	// Not a graceful leave — the case that actually happens.
	await guestCtx.close();

	await expect(host.locator('html')).toHaveAttribute('data-media-peers', '0', { timeout: 30_000 });

	await hostCtx.close();
});

test('a slot holder is actually SEEN by the other participant (UX-AV-1)', async ({ browser }) => {
	/*
	 * The product promise, end to end: someone takes a slot, turns their camera
	 * on, and the other person sees them.
	 *
	 * The assertions are about LIVENESS rather than presence, and that is the
	 * whole point. A `<video>` element that exists proves markup. One with
	 * dimensions proves a stream was attached. Neither distinguishes a live
	 * camera from a black frame frozen at the first keyframe — so `currentTime`
	 * must be seen ADVANCING between two samples, which nothing but decoding
	 * frames produces.
	 */
	const room = roomName('seen');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	await hostRoom(host, room);
	await settled(host);
	await joinRoom(guest, room, 'OnCamera');
	await settled(guest);

	await expect(host.locator('html')).toHaveAttribute('data-media-peers', '1', { timeout: 60_000 });

	// The guest takes the video slot.
	await guest.getByRole('button', { name: /Turn camera on/ }).click();
	await settled(guest);

	// A video element appears in the HOST's view — on the guest's tile, not the
	// host's own, which is what makes this a remote stream rather than a local
	// preview.
	const remote = host.locator('.avatar:not(.self) video');
	await expect(remote).toHaveCount(1, { timeout: 60_000 });

	// Decoding, with real dimensions.
	await expect
		.poll(
			async () =>
				remote.evaluate(
					(node: HTMLVideoElement) => node.videoWidth > 0 && node.readyState >= 2
				),
			{ timeout: 60_000, intervals: [500] }
		)
		.toBe(true);

	// ...and ADVANCING. A black-but-playing element passes every check above.
	const first = await remote.evaluate((node: HTMLVideoElement) => node.currentTime);
	await expect
		.poll(async () => remote.evaluate((node: HTMLVideoElement) => node.currentTime), {
			timeout: 30_000,
			intervals: [500]
		})
		.toBeGreaterThan(first);

	await hostCtx.close();
	await guestCtx.close();
});
