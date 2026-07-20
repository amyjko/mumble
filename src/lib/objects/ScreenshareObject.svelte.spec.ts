import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ScreenshareObject from './ScreenshareObject.svelte';
import { newScreenshare } from '$lib/model/create';

/**
 * A share's sound, and the control for it (UX-OBJ-16).
 *
 * A real browser, with real `MediaStream`s: the whole subject is what an element
 * does with a stream that has an audio track, and a fake would prove nothing.
 *
 * The autoplay case is the reason this file exists. Once sound rides the same
 * element as the picture, a refused `play()` is a BLACK RECTANGLE rather than a
 * silent share. The e2e suite cannot see it — Playwright sets
 * `--autoplay-policy=no-user-gesture-required` — so this is where it is covered.
 *
 * And it is not hypothetical: writing these tests is how that was established.
 * The toggle test below failed on its first run because the element came up
 * muted, which is the policy firing in this very harness. See the last describe.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';

/** A real video track. A painted canvas needs no permission and no cast. */
function painted(): MediaStreamTrack {
	const canvas = document.createElement('canvas');
	canvas.width = 16;
	canvas.height = 9;
	const context = canvas.getContext('2d');
	if (context === null) throw new Error('no 2d context');
	context.fillRect(0, 0, canvas.width, canvas.height);
	const track = canvas.captureStream(1).getVideoTracks()[0];
	if (track === undefined) throw new Error('no video track');
	return track;
}

/** A real audio track, from an oscillator. */
function tone(): MediaStreamTrack {
	const context = new AudioContext();
	const oscillator = context.createOscillator();
	const destination = context.createMediaStreamDestination();
	oscillator.connect(destination);
	oscillator.start();
	const track = destination.stream.getAudioTracks()[0];
	if (track === undefined) throw new Error('no audio track');
	return track;
}

function mount(options: { withAudio: boolean; isSelf?: boolean }): void {
	const tracks = options.withAudio ? [painted(), tone()] : [painted()];
	void render(ScreenshareObject, {
		object: newScreenshare(OWNER, { x: 0, y: 0 }, 0),
		stream: new MediaStream(tracks),
		ownerName: 'Ada',
		isSelf: options.isSelf ?? false
	});
}

/** The element under test, narrowed rather than asserted — casts are banned. */
function video(): HTMLVideoElement {
	const element = document.querySelector('video');
	if (!(element instanceof HTMLVideoElement)) throw new Error('no video element');
	return element;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('the sound control appears only when there is sound', () => {
	it('shows nothing for a share with no audio track', () => {
		// The majority real case — Chrome's "share tab audio" box is unchecked by
		// default. An inert mute button would lie about what the share carries.
		mount({ withAudio: false });
		// Absence is asserted by COUNT, not by a negated element matcher: the
		// locator matchers retry until they time out, so `.not.toBeInTheDocument()`
		// spends the full timeout proving something that is true immediately.
		expect(video().srcObject).not.toBeNull();
		expect(page.getByRole('button', { name: /Mute|Unmute/ }).elements()).toHaveLength(0);
	});

	it('shows a mute control for a share WITH audio', async () => {
		mount({ withAudio: true });
		await expect.element(page.getByRole('button', { name: /Mute Ada’s shared screen/ })).toBeVisible();
	});

	it('shows nothing on your OWN share, which you already hear', () => {
		mount({ withAudio: true, isSelf: true });
		expect(page.getByRole('button', { name: /Mute|Unmute/ }).elements()).toHaveLength(0);
		expect(video().muted).toBe(true);
	});
});

describe('muting is per viewer', () => {
	it('toggles the element both ways', async () => {
		/*
		 * `play()` is stubbed to SUCCEED here, and that is not scaffolding — it
		 * isolates this test from the autoplay policy, which genuinely fires in
		 * this harness (see the describe below). Without it the element starts
		 * muted-because-blocked and this would be testing the wrong thing.
		 */
		vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
		mount({ withAudio: true });
		const mute = page.getByRole('button', { name: /Mute Ada’s shared screen/ });
		// Awaited before acting: `render` resolves on mount, but the control is
		// derived from the stream's tracks, so it appears a tick later.
		await expect.element(mute).toBeVisible();
		expect(video().muted).toBe(false);

		await mute.click();
		await expect.element(page.getByRole('button', { name: /Unmute/ })).toBeVisible();
		expect(video().muted).toBe(true);

		await page.getByRole('button', { name: /Unmute/ }).click();
		await expect.element(page.getByRole('button', { name: /Mute Ada/ })).toBeVisible();
		expect(video().muted).toBe(false);
	});
});

/**
 * NOT a hypothetical path.
 *
 * Chrome is documented as exempting `MediaStream`-sourced elements from the
 * autoplay policy, which is why the peer-voice `<audio>` loop has never
 * misbehaved — so this fallback was expected to be belt-and-braces. It is not:
 * in this harness, with no prior user gesture in the page, an unmuted element
 * carrying an audio track is refused, and the first version of the toggle test
 * above failed because the element came up muted.
 *
 * The rejection is still INJECTED below rather than relied upon, because
 * "whether the policy fires" is a browser decision that varies by version,
 * engagement history and harness — exactly the thing a test must not depend on.
 */
describe('a browser that refuses audible playback', () => {
	it('falls back to muted rather than showing nothing', async () => {
		/*
		 * The failure mode this guards. A rejected `play()` on an element carrying
		 * both tracks means no PICTURE either, so the share reads as broken rather
		 * than as muted. Falling back to muted playback always succeeds.
		 */
		vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(
			new DOMException('blocked', 'NotAllowedError')
		);
		mount({ withAudio: true });

		await expect
			.element(page.getByRole('button', { name: /Click to allow sound/ }))
			.toBeVisible();
		expect(video().muted).toBe(true);
	});

	it('recovers on a click, which IS the gesture the policy wanted', async () => {
		const play = vi
			.spyOn(HTMLMediaElement.prototype, 'play')
			.mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
		mount({ withAudio: true });
		await expect.element(page.getByRole('button', { name: /Click to allow sound/ })).toBeVisible();

		// The policy is satisfied by a real user gesture, so the retry succeeds.
		play.mockResolvedValue(undefined);
		await page.getByRole('button', { name: /Click to allow sound/ }).click();

		expect(video().muted).toBe(false);
		await expect.element(page.getByRole('button', { name: /Mute Ada’s shared screen/ })).toBeVisible();
	});
});
