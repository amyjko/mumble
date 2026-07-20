import { describe, expect, it } from 'vitest';
import { StreamCombiner } from './combine';

/**
 * Joining a share's picture and sound (UX-OBJ-16).
 *
 * A BROWSER test, because the property under test is about real `MediaStream`
 * identity — the thing an element's `srcObject` compares — and a fake would
 * prove nothing about it.
 *
 * The failure this file exists to prevent is silent. `screenStreams` derives
 * from a map that changes whenever any peer's any track moves, so a combiner
 * that minted a new stream on every call would re-attach the share's element
 * whenever somebody unrelated switched their camera on: playback restarts, the
 * picture flickers, the viewer's mute resets. Every other test would still pass.
 */

const ALICE = 'aaaaaaaa-1111-4111-8111-111111111111';
const BOB = 'bbbbbbbb-2222-4222-8222-222222222222';

/** A real video track — a painted canvas needs no permission and no cast. */
function painted(): MediaStream {
	const canvas = document.createElement('canvas');
	canvas.width = 16;
	canvas.height = 9;
	const context = canvas.getContext('2d');
	if (context === null) throw new Error('no 2d context');
	context.fillRect(0, 0, canvas.width, canvas.height);
	return canvas.captureStream(1);
}

/** A real audio track, from an oscillator. Same trick the transport specs use. */
function tone(): MediaStream {
	const context = new AudioContext();
	const oscillator = context.createOscillator();
	const destination = context.createMediaStreamDestination();
	oscillator.connect(destination);
	oscillator.start();
	return destination.stream;
}

describe('identity is the contract', () => {
	it('THE property: the same inputs give back the SAME stream', () => {
		// Not an equal one — the same object. `srcObject` compares by identity,
		// so an equal-but-new stream is a full re-attach.
		const combiner = new StreamCombiner();
		const video = painted();
		const audio = tone();

		const first = combiner.combine(ALICE, video, audio);
		const second = combiner.combine(ALICE, video, audio);
		expect(second).toBe(first);
	});

	it('mints a new one only when the inputs actually change', () => {
		const combiner = new StreamCombiner();
		const video = painted();

		const silent = combiner.combine(ALICE, video, undefined);
		expect(silent.getAudioTracks()).toHaveLength(0);

		// Sound arrives a beat after the picture — the ordinary case.
		const withSound = combiner.combine(ALICE, video, tone());
		expect(withSound).not.toBe(silent);
		expect(withSound.getVideoTracks()).toHaveLength(1);
		expect(withSound.getAudioTracks()).toHaveLength(1);
	});

	it('goes back to picture-only when the sound ends alone', () => {
		// Correct that this re-mints: there is nothing left to mute, and the
		// element genuinely has different content to carry.
		const combiner = new StreamCombiner();
		const video = painted();
		const withSound = combiner.combine(ALICE, video, tone());

		const silent = combiner.combine(ALICE, video, undefined);
		expect(silent).not.toBe(withSound);
		expect(silent.getAudioTracks()).toHaveLength(0);
		expect(silent.getVideoTracks()).toHaveLength(1);
	});

	it('keeps peers apart', () => {
		const combiner = new StreamCombiner();
		const video = painted();
		expect(combiner.combine(BOB, video, undefined)).not.toBe(
			combiner.combine(ALICE, video, undefined)
		);
	});

	it('forgets a peer, so a rejoin does not replay a dead share', () => {
		const combiner = new StreamCombiner();
		const video = painted();
		const first = combiner.combine(ALICE, video, undefined);
		combiner.forget(ALICE);
		expect(combiner.combine(ALICE, video, undefined)).not.toBe(first);
	});

	it('clears everything at once', () => {
		const combiner = new StreamCombiner();
		const video = painted();
		const first = combiner.combine(ALICE, video, undefined);
		combiner.clear();
		expect(combiner.combine(ALICE, video, undefined)).not.toBe(first);
	});
});
