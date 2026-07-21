/**
 * How loud am I? (AR-MEDIA-6, UX-STAGE-5)
 *
 * The active-speaker cap needs a number per person, and this is where that
 * number comes from: an analyser on your OWN microphone track, sampled and
 * smoothed, broadcast as an ephemeral fact for everyone to select from.
 *
 * MEASURED LOCALLY AND SHARED, rather than measured per listener from received
 * audio. Three reasons, in order of weight:
 *
 *  1. AR-MEDIA-6 requires ONE selection — "one implementation, one source of
 *     truth". If each listener measured what they received, each would compute
 *     a slightly different ranking from slightly different arrival times, and
 *     on P2P there is no forwarder to reconcile them.
 *  2. It is measurable BEFORE the cap applies. A listener cannot measure
 *     somebody the cap has already gated, so a per-listener scheme could never
 *     let a silenced person back in — the cap would latch.
 *  3. It costs one analyser per browser rather than one per peer per browser.
 *
 * Deliberately NOT a `MediaStreamDestination` or a recorder: this reads
 * amplitude and keeps nothing (UX-ROOM-7 is enforced by a guardrail that would
 * fail on either).
 */

/** How often the level is sampled and reported, in milliseconds. */
const SAMPLE_MS = 200;

/**
 * Smoothing, as the weight given to a new sample.
 *
 * Rises fast and falls slow. A speaker should be ranked the instant they start
 * — a slow attack clips the first word — while a fall that tracked every gap
 * between syllables would make the ranking jitter even though
 * `selectActiveSpeakers` holds the floor separately. The hold handles turn
 * changes; this handles the shape of a single utterance.
 */
const ATTACK = 0.7;
const DECAY = 0.15;

export interface VoiceLevelMeter {
	/** Stop sampling and release the audio graph. */
	stop(): void;
}

/**
 * Start reporting this track's loudness, roughly five times a second.
 *
 * Returns null when the browser has no Web Audio — the cap then simply never
 * narrows, which is the right failure: everyone the stage authorized stays
 * audible, exactly as before this existed. A missing analyser must not silence
 * a room.
 */
export function meterVoiceLevel(
	track: MediaStreamTrack,
	report: (level: number) => void
): VoiceLevelMeter | null {
	if (typeof AudioContext === 'undefined') return null;

	const context = new AudioContext();
	const source = context.createMediaStreamSource(new MediaStream([track]));
	const analyser = context.createAnalyser();
	// Small window: this is an amplitude envelope, not a spectrum, and a large
	// FFT would cost more and say the same thing.
	analyser.fftSize = 512;
	source.connect(analyser);
	/*
	 * Deliberately NOT connected to `context.destination`. Routing your own
	 * microphone to your own speakers is feedback, and it is the classic way an
	 * analyser gets wired in by accident — the graph works either way, so
	 * nothing fails except the room.
	 */

	const samples = new Float32Array(analyser.fftSize);
	let smoothed = 0;
	let stopped = false;

	const timer = setInterval(() => {
		if (stopped) return;
		analyser.getFloatTimeDomainData(samples);

		// RMS: the energy in the window, which tracks perceived loudness far
		// better than a peak does — one click would peg a peak meter.
		let sum = 0;
		for (const sample of samples) sum += sample * sample;
		const rms = Math.sqrt(sum / samples.length);

		// Scaled so ordinary speech lands in the upper half of 0..1. Raw RMS on
		// a voice track sits around 0.05–0.2, which would make every comparison
		// happen in the bottom tenth of the range.
		const scaled = Math.min(1, rms * 5);
		smoothed = scaled > smoothed ? smoothed + (scaled - smoothed) * ATTACK : smoothed + (scaled - smoothed) * DECAY;

		report(Math.round(smoothed * 100) / 100);
	}, SAMPLE_MS);

	return {
		stop(): void {
			stopped = true;
			clearInterval(timer);
			source.disconnect();
			analyser.disconnect();
			void context.close().catch(() => undefined);
		}
	};
}
