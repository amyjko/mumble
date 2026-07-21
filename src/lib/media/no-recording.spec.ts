import { describe, expect, it } from 'vitest';
import { offendingLines, sourceFiles } from '$lib/test/source-scan';

/**
 * There is no A/V recording (UX-ROOM-7).
 *
 * The requirement's tag read "trivially true (no capture code exists) but
 * unverifiable until the A/V plane lands". The A/V plane landed 2026-07-20, and
 * "trivially true" stopped being a safe thing to say the moment there were real
 * `MediaStreamTrack`s in the product to record.
 *
 * This is a PROMISE TO PARTICIPANTS, not an implementation detail: "A/V streams
 * are ephemeral and never captured" is the sort of claim people decide whether
 * to speak freely on the strength of. A promise like that should not rest on
 * nobody having got round to breaking it. So it is checked, the same way the
 * transport seam and the design tokens are.
 *
 * What it does NOT constrain: persisted state. Layout, notes, chat logs and
 * drawings are the record of a meeting and are supposed to survive it — the
 * requirement says so. Only the streams are ephemeral.
 */

/**
 * The APIs that turn a live stream into bytes you could keep.
 *
 * `MediaRecorder` is the direct one. `captureStream` is the flanking route —
 * pulling a stream off a `<video>` or `<canvas>` element, which is how you would
 * record without ever naming a recorder. `webkitGetUserMedia`-era aliases are
 * not included: capture is not recording, and `getUserMedia` is already
 * governed by the provider-names rule.
 *
 * `createMediaStreamDestination` is Web Audio's route to the same place — it
 * produces a stream that a recorder consumes, and Track D's voice-level work
 * uses Web Audio nearby, so the one Web Audio call that leads to bytes is named
 * explicitly rather than left to a reviewer to notice.
 */
const RECORDING_APIS =
	/\bMediaRecorder\b|\bcaptureStream\b|\bcreateMediaStreamDestination\b|\btoDataURL\b|\btoBlob\b/;

describe('no A/V recording exists (UX-ROOM-7)', () => {
	/*
	 * SPECS ARE EXEMPT, and the reason is the requirement's own scope rather
	 * than convenience.
	 *
	 * UX-ROOM-7 is a promise to the people in a room: what they say is not kept.
	 * A spec file ships to nobody. And these specs use the very same APIs for
	 * the opposite purpose — `canvas.captureStream()` and
	 * `createMediaStreamDestination()` MANUFACTURE a track, because a test has
	 * no camera and no microphone. Eight files did exactly that when this rule
	 * first ran, which is how the exemption came to be written down instead of
	 * assumed.
	 *
	 * The rule keeps its teeth where they matter: every shipped module, every
	 * component, every route. A recorder in `Room.svelte` still fails.
	 */
	const files = sourceFiles({
		exempt: (relative) => /\.spec\.ts$/.test(relative)
	});

	it('finds source files to check', () => {
		expect(files.length).toBeGreaterThan(50);
	});

	it('the exemption did not swallow the product', () => {
		// A `.spec.` pattern that accidentally matched everything would make this
		// rule vacuous while still reporting a long green list. So: the files
		// actually checked must include the components and routes that handle
		// real media.
		const checked = new Set(files.map((f) => f.relative));
		expect(checked.has('lib/canvas/Room.svelte')).toBe(true);
		expect(checked.has('lib/canvas/AvatarTile.svelte')).toBe(true);
		expect(checked.has('lib/objects/ScreenshareObject.svelte')).toBe(true);
		expect(checked.has('lib/media/capture.ts')).toBe(true);
		expect(checked.has('lib/media/session.svelte.ts')).toBe(true);
	});

	it.each(files.map((f) => [f.relative, f] as const))('%s captures no stream', (_relative, file) => {
		expect(offendingLines(file, RECORDING_APIS)).toEqual([]);
	});

	it('the pattern actually matches what it claims to', () => {
		// The guard on the guard: a regex that matched nothing would pass every
		// file above and read as proof.
		expect(RECORDING_APIS.test('const rec = new MediaRecorder(stream);')).toBe(true);
		expect(RECORDING_APIS.test('const s = videoElement.captureStream();')).toBe(true);
		expect(RECORDING_APIS.test('const dest = ctx.createMediaStreamDestination();')).toBe(true);
		expect(RECORDING_APIS.test('canvas.toBlob(cb)')).toBe(true);
		// Ordinary media handling is untouched — this bans keeping, not playing.
		expect(RECORDING_APIS.test('element.srcObject = stream;')).toBe(false);
		expect(RECORDING_APIS.test('track.enabled = false;')).toBe(false);
	});
});
