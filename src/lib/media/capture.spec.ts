import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Capture, ScreenCapture } from './capture';

/**
 * Acquiring and releasing the camera (UX-AV-3, AR-CTRL-3).
 *
 * `getUserMedia` is stubbed rather than driven, because what matters here is the
 * DECISION sequence — when we ask, when we stop asking, when we ask again — and
 * a real device would only make that harder to observe. The browser half is
 * covered where a browser is available.
 */

const media = { getUserMedia: vi.fn(), getDisplayMedia: vi.fn() };

beforeEach(() => {
	media.getUserMedia.mockReset();
	media.getDisplayMedia.mockReset();
	vi.stubGlobal('navigator', { mediaDevices: media });
});

/** A stream whose tracks record that they were stopped. */
function fakeStream(kinds: readonly string[]) {
	const tracks = kinds.map((kind) => ({ kind, stop: vi.fn(), getSettings: () => ({ width: 640 }) }));
	return {
		getTracks: () => tracks,
		getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
		getAudioTracks: () => tracks.filter((t) => t.kind === 'audio')
	};
}

/**
 * A display track. `onended` is declared through an interface rather than an
 * `as` assertion, which this codebase bans — the field has to be nullable AND
 * assignable so a test can fire the browser's own "Stop sharing".
 */
interface FakeScreenTrack {
	kind: string;
	contentHint: string;
	onended: (() => void) | null;
	stop: () => void;
	getSettings: () => { width: number };
}

/**
 * A share, with or without its own sound. `withAudio` defaults to false because
 * that is the common real case — Chrome's "share tab audio" checkbox is
 * unchecked by default, and Safari never offers one at all.
 */
function fakeScreen(withAudio = false) {
	const track: FakeScreenTrack = {
		kind: 'video',
		contentHint: '',
		onended: null,
		stop: vi.fn(),
		getSettings: () => ({ width: 1920 })
	};
	const audio: FakeScreenTrack = {
		kind: 'audio',
		contentHint: '',
		onended: null,
		stop: vi.fn(),
		getSettings: () => ({ width: 0 })
	};
	const tracks = withAudio ? [track, audio] : [track];
	return {
		track,
		audio,
		stream: {
			getTracks: () => tracks,
			getVideoTracks: () => [track],
			getAudioTracks: () => (withAudio ? [audio] : [])
		}
	};
}

describe('asking once', () => {
	it('prompts for both kinds in a single call', async () => {
		// Two dialogs for one action is worse than one, and a browser that grants
		// the camera usually grants the microphone in the same gesture.
		media.getUserMedia.mockResolvedValue(fakeStream(['video', 'audio']));
		const capture = new Capture();
		await capture.reconcile({ video: true, audio: true });
		expect(media.getUserMedia).toHaveBeenCalledTimes(1);
		expect(media.getUserMedia).toHaveBeenCalledWith({ video: true, audio: true });
	});

	it('does not ask again once it holds what it needs', async () => {
		media.getUserMedia.mockResolvedValue(fakeStream(['video']));
		const capture = new Capture();
		await capture.reconcile({ video: true, audio: false });
		await capture.reconcile({ video: true, audio: false });
		// Re-prompting on every plan would flash the permission indicator and
		// restart the camera — a visible flicker in everyone else's tile.
		expect(media.getUserMedia).toHaveBeenCalledTimes(1);
	});
});

describe('a refusal', () => {
	it('is a state, not an error', async () => {
		// Throwing would take a room down over a permission somebody is entitled
		// to withhold.
		media.getUserMedia.mockRejectedValue(new Error('NotAllowedError'));
		const capture = new Capture();
		await expect(capture.reconcile({ video: true, audio: false })).resolves.toEqual([]);
		expect(capture.denied).toBe(true);
		expect(capture.get('video')).toBeNull();
	});

	it('stops us asking again while they are still trying', async () => {
		media.getUserMedia.mockRejectedValue(new Error('NotAllowedError'));
		const capture = new Capture();
		await capture.reconcile({ video: true, audio: false });
		await capture.reconcile({ video: true, audio: false });
		await capture.reconcile({ video: true, audio: false });
		// One dialog, not one per plan pass.
		expect(media.getUserMedia).toHaveBeenCalledTimes(1);
	});

	it('is FORGOTTEN once they stop asking, so turning it off and on retries', async () => {
		/*
		 * The latch used to be permanent, and that was the bug. Somebody who
		 * refused, then granted the camera in their browser settings, stayed dark
		 * until they reloaded — and nothing told them a reload was the fix.
		 *
		 * Releasing the slot is the one moment we know they have stopped trying,
		 * so it is the safe place to forget. Toggling the camera off and on again
		 * is what anyone would try first, and now it works.
		 */
		media.getUserMedia.mockRejectedValue(new Error('NotAllowedError'));
		const capture = new Capture();
		await capture.reconcile({ video: true, audio: false });
		expect(capture.denied).toBe(true);

		// Camera off.
		await capture.reconcile({ video: false, audio: false });
		expect(capture.denied).toBe(false);

		// Camera on again, permission since granted.
		media.getUserMedia.mockResolvedValue(fakeStream(['video']));
		await capture.reconcile({ video: true, audio: false });
		expect(media.getUserMedia).toHaveBeenCalledTimes(2);
		expect(capture.get('video')).not.toBeNull();
		expect(capture.denied).toBe(false);
	});
});

describe('releasing', () => {
	it('stops the track, so the hardware light goes out', async () => {
		const stream = fakeStream(['video']);
		media.getUserMedia.mockResolvedValue(stream);
		const capture = new Capture();
		await capture.reconcile({ video: true, audio: false });
		const track = stream.getVideoTracks()[0];

		await capture.reconcile({ video: false, audio: false });
		// Dropping the reference is not enough: a camera nobody stops keeps its
		// light on, and a person who stopped publishing expects it to go out.
		expect(track?.stop).toHaveBeenCalled();
		expect(capture.get('video')).toBeNull();
	});

	it('reports which kinds changed, so a caller republishes only those', async () => {
		media.getUserMedia.mockResolvedValue(fakeStream(['video', 'audio']));
		const capture = new Capture();
		expect(await capture.reconcile({ video: true, audio: true })).toEqual(
			expect.arrayContaining(['video', 'audio'])
		);
		// Nothing changed the second time.
		expect(await capture.reconcile({ video: true, audio: true })).toEqual([]);
	});

	it('stops everything on dispose', async () => {
		const stream = fakeStream(['video', 'audio']);
		media.getUserMedia.mockResolvedValue(stream);
		const capture = new Capture();
		await capture.reconcile({ video: true, audio: true });

		capture.dispose();
		for (const track of stream.getTracks()) expect(track.stop).toHaveBeenCalled();
		// And a disposed capture acquires nothing further: leaving the room while
		// the permission dialog is open used to leave the camera on afterwards.
		expect(await capture.reconcile({ video: true, audio: true })).toEqual([]);
	});
});

/**
 * The screen (UX-OBJ-6).
 *
 * The decisions here are DIFFERENT from the camera's, and that difference is
 * what these assert: a picker is not a permission, so a cancel leaves no state
 * behind; and the browser can end a share on its own, which nothing in a
 * reconcile loop could ever observe.
 */
describe('screen capture', () => {
	it('opens the picker and hands back the track', async () => {
		const { track, stream } = fakeScreen();
		media.getDisplayMedia.mockResolvedValue(stream);
		const screen = new ScreenCapture();
		expect(await screen.start()).toBe(track);
		expect(screen.current).toBe(track);
	});

	it('hints DETAIL, because a screen is text rather than a face', async () => {
		const { track, stream } = fakeScreen();
		media.getDisplayMedia.mockResolvedValue(stream);
		const screen = new ScreenCapture();
		await screen.start();
		expect(track.contentHint).toBe('detail');
	});

	it('treats a cancelled picker as an answer, not an error', async () => {
		media.getDisplayMedia.mockRejectedValue(new Error('NotAllowedError'));
		const screen = new ScreenCapture();
		expect(await screen.start()).toBeNull();
		expect(screen.current).toBeNull();
	});

	it('LATCHES NOTHING: clicking share again after a cancel asks again', async () => {
		// The camera latches a refusal to avoid re-prompting on every plan. A
		// screen has no such loop to protect, and latching would make "I changed
		// my mind" permanent — the next click would silently do nothing.
		media.getDisplayMedia.mockRejectedValueOnce(new Error('NotAllowedError'));
		const { track, stream } = fakeScreen();
		media.getDisplayMedia.mockResolvedValueOnce(stream);

		const screen = new ScreenCapture();
		expect(await screen.start()).toBeNull();
		expect(await screen.start()).toBe(track);
		expect(media.getDisplayMedia).toHaveBeenCalledTimes(2);
	});

	it('does not open a second picker over a live share', async () => {
		const { track, stream } = fakeScreen();
		media.getDisplayMedia.mockResolvedValue(stream);
		const screen = new ScreenCapture();
		await screen.start();
		expect(await screen.start()).toBe(track);
		expect(media.getDisplayMedia).toHaveBeenCalledTimes(1);
	});

	it('reports a share the BROWSER ended', async () => {
		// The "Stop sharing" bar. No state changes anywhere, so a reconcile loop
		// would never notice — this event edge is the only way to find out.
		const { track, stream } = fakeScreen();
		media.getDisplayMedia.mockResolvedValue(stream);
		const screen = new ScreenCapture();
		await screen.start();

		const told = vi.fn();
		screen.onEnded(told);
		track.onended?.();

		expect(told).toHaveBeenCalledTimes(1);
		expect(screen.current).toBeNull();
	});

	it('stops the track, and stops reporting after it is unsubscribed', async () => {
		const { track, stream } = fakeScreen();
		media.getDisplayMedia.mockResolvedValue(stream);
		const screen = new ScreenCapture();
		await screen.start();

		const told = vi.fn();
		const off = screen.onEnded(told);
		off();
		screen.stop();

		expect(track.stop).toHaveBeenCalled();
		expect(screen.current).toBeNull();
		expect(told).not.toHaveBeenCalled();
	});

	it('stops a share that arrives after disposal', async () => {
		// Leaving the room while the picker is open. The share would otherwise
		// stay live after the page is gone.
		const { track, stream } = fakeScreen();
		// Held in an object rather than a `let`: assigning a closure parameter to
		// a local narrows it to `never` at the call site.
		const picker: { settle: (value: unknown) => void } = { settle: () => undefined };
		media.getDisplayMedia.mockReturnValue(
			new Promise((resolve) => {
				picker.settle = resolve;
			})
		);

		const screen = new ScreenCapture();
		const pending = screen.start();
		screen.dispose();
		picker.settle(stream);

		expect(await pending).toBeNull();
		expect(track.stop).toHaveBeenCalled();
		expect(screen.current).toBeNull();
	});
});

/**
 * A share's own sound (UX-OBJ-16).
 *
 * The lifecycle is what these are about. A share IS its picture, so the two
 * tracks are not peers: the picture ending takes the sound with it, and the
 * sound ending on its own must leave a live share alone.
 */
describe('screen audio', () => {
	it('ASKS for audio, which is how the browser’s checkbox appears at all', async () => {
		media.getDisplayMedia.mockResolvedValue(fakeScreen().stream);
		await new ScreenCapture().start();
		expect(media.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
	});

	it('takes the sound when it is offered', async () => {
		const { audio, stream } = fakeScreen(true);
		media.getDisplayMedia.mockResolvedValue(stream);
		const screen = new ScreenCapture();
		await screen.start();
		expect(screen.currentAudio).toBe(audio);
	});

	it('treats NO sound as ordinary, not as a failure', async () => {
		// The majority case in the field: the checkbox was left unchecked, or the
		// browser never offered one. The share must be indistinguishable from a
		// successful one in every code path.
		const { track, stream } = fakeScreen(false);
		media.getDisplayMedia.mockResolvedValue(stream);
		const screen = new ScreenCapture();
		expect(await screen.start()).toBe(track);
		expect(screen.currentAudio).toBeNull();
	});

	it('THE lifecycle rule: the sound ending does NOT end the share', async () => {
		/*
		 * Switching which tab you share can end the audio track on its own. One
		 * handler attached to both tracks — the naive implementation — would tear
		 * down a perfectly live picture at that moment.
		 */
		const { track, audio, stream } = fakeScreen(true);
		media.getDisplayMedia.mockResolvedValue(stream);
		const screen = new ScreenCapture();
		await screen.start();

		const shareEnded = vi.fn();
		const audioEnded = vi.fn();
		screen.onEnded(shareEnded);
		screen.onAudioEnded(audioEnded);

		audio.onended?.();

		expect(audioEnded).toHaveBeenCalledTimes(1);
		expect(shareEnded).not.toHaveBeenCalled();
		expect(screen.current).toBe(track);
		expect(screen.currentAudio).toBeNull();
	});

	it('the PICTURE ending takes the sound with it', async () => {
		const { track, audio, stream } = fakeScreen(true);
		media.getDisplayMedia.mockResolvedValue(stream);
		const screen = new ScreenCapture();
		await screen.start();

		const shareEnded = vi.fn();
		screen.onEnded(shareEnded);
		// Fired on the fake, not through `screen.current` — the DOM signature
		// takes an Event and this one deliberately does not.
		track.onended?.();

		expect(shareEnded).toHaveBeenCalledTimes(1);
		expect(screen.current).toBeNull();
		expect(screen.currentAudio).toBeNull();
		expect(audio.stop).toHaveBeenCalled();
	});

	it('stop() gives both tracks back', async () => {
		const { track, audio, stream } = fakeScreen(true);
		media.getDisplayMedia.mockResolvedValue(stream);
		const screen = new ScreenCapture();
		await screen.start();
		screen.stop();
		expect(track.stop).toHaveBeenCalled();
		expect(audio.stop).toHaveBeenCalled();
		expect(screen.currentAudio).toBeNull();
	});

	it('stops a stream that arrives with sound but no picture', async () => {
		// Without stopping everything before the early return, the browser would
		// keep capturing audio for a share that never existed.
		const { audio } = fakeScreen(true);
		media.getDisplayMedia.mockResolvedValue({
			getTracks: () => [audio],
			getVideoTracks: () => [],
			getAudioTracks: () => [audio]
		});
		const screen = new ScreenCapture();
		expect(await screen.start()).toBeNull();
		expect(audio.stop).toHaveBeenCalled();
	});

	it('stops both when the share arrives after disposal', async () => {
		const { track, audio, stream } = fakeScreen(true);
		const picker: { settle: (value: unknown) => void } = { settle: () => undefined };
		media.getDisplayMedia.mockReturnValue(
			new Promise((resolve) => {
				picker.settle = resolve;
			})
		);

		const screen = new ScreenCapture();
		const pending = screen.start();
		screen.dispose();
		picker.settle(stream);

		expect(await pending).toBeNull();
		expect(track.stop).toHaveBeenCalled();
		expect(audio.stop).toHaveBeenCalled();
	});
});
