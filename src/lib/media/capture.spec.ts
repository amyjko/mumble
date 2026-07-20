import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Capture } from './capture';

/**
 * Acquiring and releasing the camera (UX-AV-3, AR-CTRL-3).
 *
 * `getUserMedia` is stubbed rather than driven, because what matters here is the
 * DECISION sequence — when we ask, when we stop asking, when we ask again — and
 * a real device would only make that harder to observe. The browser half is
 * covered where a browser is available.
 */

const media = { getUserMedia: vi.fn() };

beforeEach(() => {
	media.getUserMedia.mockReset();
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
