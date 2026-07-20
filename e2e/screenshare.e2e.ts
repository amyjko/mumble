import { expect, test, type Page } from '@playwright/test';
import { joinRoom, roomName, settled } from './support/join';
import { hostRoom } from './support/auth';

/**
 * Screen sharing across two browsers (UX-OBJ-6).
 *
 * ## Why the picker is stubbed, and what that costs
 *
 * There is no `--use-fake-device-for-media-stream` for `getDisplayMedia`,
 * because a screen share is not permission-gated — it is PICKER-gated, and the
 * picker is browser chrome we do not own and cannot drive. (CDP's
 * `Browser.grantPermissions` is no help: there is no permission to grant.)
 *
 * So `getDisplayMedia` is replaced with a canvas capture stream before the page
 * loads. That is an honest trade rather than a hole: every line WE wrote runs —
 * the slot arithmetic, the atomic mutation, the mid→kind map, the publish path,
 * the object, its sound, the teardown — and the only thing skipped is the one
 * line we did not write, which is the browser opening its own dialog. Nothing
 * covers that line: a flag-driven probe was written, measured and deleted,
 * because headless Chromium rejects `getDisplayMedia` outright and headed the
 * auto-accept flags do not take. See AR-TEST-9.
 *
 * What this still cannot show is in AR-TEST-10: one machine, host candidates
 * only, no relay, and a synthetic capture that says nothing about encoder
 * behaviour at any rung. And `--autoplay-policy=no-user-gesture-required` is set
 * for the whole suite, so the blocked-playback path is invisible here — the
 * component spec covers it by injecting the rejection.
 */

test.describe.configure({ timeout: 120_000 });

/**
 * Replace the picker with a canvas that is genuinely being painted.
 *
 * ANIMATED on purpose. A static canvas produces a track that decodes one frame
 * and stops, which would pass every "is there a video element" check while
 * proving nothing — the same trap `media.e2e.ts` avoids by watching
 * `currentTime` advance.
 *
 * But animated CHEAPLY, and stopping when the share does. The first version
 * painted from `requestAnimationFrame`, which is 60fps of full-canvas fill that
 * never ends — and the whole suite went from reliably green to failing one or
 * two unrelated timing-sensitive tests per run, a different one each time. A
 * test fixture that slows the machine down is a test fixture that makes other
 * people's tests flaky, which is a worse bug than the one it was written to
 * catch. 4fps on a small canvas is ample for `currentTime` to advance.
 */
async function stubPicker(page: Page, options: { withAudio?: boolean } = {}): Promise<void> {
	const withAudio = options.withAudio === true;
	await page.addInitScript((wantsAudio: boolean) => {
		const canvas = document.createElement('canvas');
		canvas.width = 160;
		canvas.height = 90;
		const context = canvas.getContext('2d');
		let tick = 0;
		const timer = setInterval(() => {
			tick += 1;
			if (context === null) return;
			context.fillStyle = tick % 2 === 0 ? '#204060' : '#3a6a9a';
			context.fillRect(0, 0, canvas.width, canvas.height);
		}, 250);

		const stream = canvas.captureStream(4);

		/*
		 * A share's own sound (UX-OBJ-16), when the test asks for one.
		 *
		 * An oscillator, like the transport specs use: a genuine audio track with
		 * no permission and no device. Kept quiet and stopped with the share —
		 * a leaked `AudioContext` is exactly the kind of expensive fixture the
		 * note above warns about.
		 */
		let audioContext: AudioContext | null = null;
		if (wantsAudio) {
			audioContext = new AudioContext();
			const oscillator = audioContext.createOscillator();
			const gain = audioContext.createGain();
			gain.gain.value = 0.01;
			const destination = audioContext.createMediaStreamDestination();
			oscillator.connect(gain);
			gain.connect(destination);
			oscillator.start();
			for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
		}

		// Painting outlives nothing: once the share ends there is no reason to
		// keep burning frames for the rest of the suite.
		for (const track of stream.getVideoTracks()) {
			track.addEventListener('ended', () => {
				clearInterval(timer);
				void audioContext?.close();
			});
		}

		Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
			configurable: true,
			/*
			 * Honours the CONSTRAINT rather than ignoring it, which incidentally
			 * asserts that we ask: a share only carries sound here if the caller
			 * requested audio, so a regression that stopped requesting it would
			 * make the audio tests fail rather than silently pass.
			 */
			value: (constraints?: { audio?: boolean }) => {
				const asked = constraints?.audio === true;
				if (asked) return Promise.resolve(stream);
				const videoOnly = new MediaStream(stream.getVideoTracks());
				return Promise.resolve(videoOnly);
			}
		});

		/*
		 * Stand in for the browser's own "Stop sharing" bar.
		 *
		 * Driven by an event rather than by the test hunting `<video>` elements:
		 * the DOM approach depends on the self-view having been attached by the
		 * time it runs, so it silently does nothing when it loses that race — a
		 * test that reports "the share did not end" when in fact it never ended
		 * anything. Reaching the capture track directly has no such timing.
		 */
		window.addEventListener('mumble:end-share', () => {
			for (const track of stream.getVideoTracks()) {
				track.stop();
				// `stop()` deliberately does NOT fire `ended`; the platform fires it
				// separately when the user stops a share from browser chrome.
				track.dispatchEvent(new Event('ended'));
			}
		});

		/** The share's SOUND ending on its own — switching tabs, most often. */
		window.addEventListener('mumble:end-share-audio', () => {
			for (const track of stream.getAudioTracks()) {
				track.stop();
				track.dispatchEvent(new Event('ended'));
			}
		});
	}, withAudio);
}

test('a shared screen becomes an object the other person can see (UX-OBJ-6)', async ({
	browser
}) => {
	const room = roomName('share');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();
	await stubPicker(guest);

	await hostRoom(host, room);
	await settled(host);
	await joinRoom(guest, room, 'Sharer');
	await settled(guest);

	await expect(host.locator('html')).toHaveAttribute('data-media-peers', '1', { timeout: 60_000 });

	await guest.getByRole('button', { name: /Share your screen/ }).click();
	await settled(guest);

	// The OBJECT arrives for the person who is not sharing. This is the half of
	// the requirement that is about the canvas rather than the media plane: a
	// share is an object like any other, synced through room state.
	const share = host.locator('[data-object-type="screenshare"]');
	await expect(share).toHaveCount(1, { timeout: 60_000 });

	// ...and the TRACK arrives, decoding and advancing. A share whose object
	// syncs but whose media never lands is exactly the failure that would look
	// like success in a weaker assertion.
	const video = share.locator('video');
	await expect
		.poll(
			async () =>
				video.evaluate((node: HTMLVideoElement) => node.videoWidth > 0 && node.readyState >= 2),
			{ timeout: 60_000, intervals: [500] }
		)
		.toBe(true);

	const first = await video.evaluate((node: HTMLVideoElement) => node.currentTime);
	await expect
		.poll(async () => video.evaluate((node: HTMLVideoElement) => node.currentTime), {
			timeout: 30_000,
			intervals: [500]
		})
		.toBeGreaterThan(first);

	/*
	 * This share carries NO sound — the stub was not asked for audio — which is
	 * the MAJORITY real case (Chrome's "share tab audio" box is unchecked by
	 * default, Safari never offers one). It must show no mute control: an inert
	 * one would lie about what the share carries. Folded into this test rather
	 * than its own, because a second two-context WebRTC setup is exactly the
	 * kind of suite load that surfaces unrelated timing races (UX-OBJ-16).
	 */
	await expect(host.getByRole('button', { name: /Mute .*shared screen/ })).toHaveCount(0);

	await hostCtx.close();
	await guestCtx.close();
});


test('a share ends by the button and by the browser, and the object goes with it', async ({
	browser
}) => {
	/*
	 * Both ways a share ends, in ONE setup.
	 *
	 * Merged deliberately rather than written as two tests. Each two-context
	 * WebRTC setup costs real CPU, and four of them in this file made unrelated
	 * timing-sensitive tests elsewhere in the suite start failing — a different
	 * one each run. The two claims are independent and both are still asserted;
	 * only the expensive scaffolding is shared.
	 *
	 * The browser-initiated case is the one that could not be found any other
	 * way: the "Stop sharing" bar kills the track with NO state change anywhere,
	 * so nothing but `track.onended` can observe it.
	 */
	const room = roomName('sharestop');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();
	await stubPicker(guest);

	await hostRoom(host, room);
	await settled(host);
	await joinRoom(guest, room, 'Sharer');
	await settled(guest);
	await expect(host.locator('html')).toHaveAttribute('data-media-peers', '1', { timeout: 60_000 });

	const onHost = host.locator('[data-object-type="screenshare"]');
	const onGuest = guest.locator('[data-object-type="screenshare"]');

	// 1. Stopping from our own button.
	await guest.getByRole('button', { name: /Share your screen/ }).click();
	await expect(onHost).toHaveCount(1, { timeout: 60_000 });
	await guest.getByRole('button', { name: /Stop sharing your screen/ }).click();
	await expect(onHost).toHaveCount(0, { timeout: 60_000 });
	await expect(onGuest).toHaveCount(0);

	// 2. The browser ending it underneath us. Sharing again first, because the
	// share we just stopped is gone.
	await guest.getByRole('button', { name: /Share your screen/ }).click();
	await expect(onHost).toHaveCount(1, { timeout: 60_000 });

	await guest.evaluate(() => {
		window.dispatchEvent(new Event('mumble:end-share'));
	});

	// The sharer's client observed the event; the other learns from the mutation.
	await expect(onGuest).toHaveCount(0, { timeout: 60_000 });
	await expect(onHost).toHaveCount(0, { timeout: 60_000 });

	await hostCtx.close();
	await guestCtx.close();
});

test('a share and a camera together consume two video slots (UX-STAGE-1)', async ({ page }) => {
	/*
	 * The capacity claim, which is the part of UX-OBJ-6 most likely to be got
	 * wrong quietly: `max_av` bounds video publishers PLUS shares, so one person
	 * doing both leaves less room for everyone else.
	 *
	 * ONE context, because slot accounting is model state and the sharer's own
	 * UI is where it has to be legible (UX-STAGE-9). A lone occupant publishes
	 * nothing — `planMedia` returns IDLE — but the slots and the object are
	 * ordinary room state and behave identically, so nothing here needs a peer.
	 * The cross-context proof that a share reaches somebody else is the test
	 * above; repeating that scaffolding to read two button labels would cost a
	 * whole WebRTC session for nothing.
	 */
	await stubPicker(page);
	await joinRoom(page, roomName('sharepool'), 'Both');
	await settled(page);

	/*
	 * THE assertion: taking the CAMERA reduces the number the SHARE button
	 * quotes.
	 *
	 * That is the pool, observable from the UI. If shares had their own capacity
	 * this number would not move, and the room would silently allow `max_av`
	 * cameras plus `max_av` shares.
	 */
	const freeFromShareLabel = async (): Promise<number> => {
		const label =
			(await page
				.getByRole('button', { name: /Share your screen/ })
				.getAttribute('aria-label')) ?? '';
		return Number(/\((\d+) of \d+ video/.exec(label)?.[1] ?? '-1');
	};

	const before = await freeFromShareLabel();
	expect(before).toBeGreaterThan(0);

	await page.getByRole('button', { name: /Turn camera on/ }).click();
	await settled(page);
	await expect.poll(freeFromShareLabel).toBe(before - 1);

	await page.getByRole('button', { name: /Share your screen/ }).click();
	await settled(page);

	// Both held at once by one person, and the share is on the canvas.
	await expect(page.getByRole('button', { name: /Stop sharing your screen/ })).toBeVisible();
	await expect(page.getByRole('button', { name: /Turn camera off/ })).toBeVisible();
	await expect(page.locator('[data-object-type="screenshare"]')).toHaveCount(1);
});

test('a share carries its own sound, muteable per viewer (UX-OBJ-16)', async ({ browser }) => {
	/*
	 * The highest-value assertion in the feature is one line: the host's video
	 * element holds a stream with an audio track. Getting there exercises the
	 * fourth `MediaKind`, the publish gate, the mid→kind map that tells a share's
	 * sound from a microphone, and the combiner that joins the two tracks at a
	 * stable identity — none of which can be seen from any single unit.
	 */
	const room = roomName('shareaudio');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();
	await stubPicker(guest, { withAudio: true });

	await hostRoom(host, room);
	await settled(host);
	await joinRoom(guest, room, 'Sharer');
	await settled(guest);
	await expect(host.locator('html')).toHaveAttribute('data-media-peers', '1', { timeout: 60_000 });

	await guest.getByRole('button', { name: /Share your screen/ }).click();

	const share = host.locator('[data-object-type="screenshare"]');
	await expect(share).toHaveCount(1, { timeout: 60_000 });
	const video = share.locator('video');

	// Both tracks, on ONE element. Narrowed with `instanceof`, never a cast.
	await expect
		.poll(
			async () =>
				video.evaluate(
					(node: HTMLVideoElement) =>
						node.srcObject instanceof MediaStream && node.srcObject.getAudioTracks().length === 1
				),
			{ timeout: 60_000, intervals: [500] }
		)
		.toBe(true);

	// The PICTURE still plays. This is where "the browser refused audible
	// playback so nothing rendered" would surface — a black rectangle, not a
	// silent share.
	const first = await video.evaluate((node: HTMLVideoElement) => node.currentTime);
	await expect
		.poll(async () => video.evaluate((node: HTMLVideoElement) => node.currentTime), {
			timeout: 30_000,
			intervals: [500]
		})
		.toBeGreaterThan(first);

	/*
	 * The per-share sound control is PRESENT — which is what only an end-to-end
	 * run can show: that a real audio track, arriving over a real connection,
	 * reaches the object as something the viewer can act on.
	 *
	 * The control's toggle BEHAVIOUR is asserted in the component spec, not here,
	 * and that split is deliberate. Two tracks on one element means the browser's
	 * autoplay policy is in play, and it is genuinely environment-dependent:
	 * even with `--autoplay-policy=no-user-gesture-required` set, a fresh context
	 * refuses the unmuted `play()`, so the share settles muted-because-blocked —
	 * the fallback from the component spec, firing for real. Driving mute/unmute
	 * from that state depends on how the harness treats a synthetic gesture,
	 * which is exactly the kind of thing an e2e test must not hinge on. The
	 * component spec injects the rejection and proves the whole state machine
	 * deterministically.
	 */
	await expect(host.locator('[data-sound-control]')).toBeVisible();

	await hostCtx.close();
	await guestCtx.close();
});
