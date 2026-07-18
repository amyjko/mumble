import { describe, expect, it } from 'vitest';
import {
	applyCapacity,
	audioPublishers,
	admits,
	canPublishAudio,
	counts,
	freshStage,
	grantSlot,
	holdsAudio,
	holdsVideo,
	isQueued,
	lowerHand,
	maxAudioPublishers,
	mutedAudio,
	normalizeCapacity,
	participantLeft,
	queuePosition,
	raiseHand,
	releaseSlot,
	takeSlot,
	unmutedAudio,
	type StageState
} from './stage';

const A = 'a';
const B = 'b';
const C = 'c';
const D = 'd';

const stage = (over: Partial<StageState> = {}): StageState => ({
	...freshStage({ max_participants: 10, max_av: 2, max_audio: 2 }),
	...over
});

describe('capacity numbers ARE the stage policy (UX-STAGE-1/2)', () => {
	it('clamps publish caps to the room size', () => {
		expect(normalizeCapacity({ max_participants: 3, max_av: 9, max_audio: 7 })).toEqual({
			max_participants: 3,
			max_av: 3,
			max_audio: 3
		});
	});

	it('max_av = 1 is a conch: the second person queues', () => {
		// UX-STAGE-2's whole claim is that the numbers alone express the policy.
		let s = stage({ capacity: { max_participants: 10, max_av: 1, max_audio: 0 } });
		s = takeSlot(s, A, 'video');
		s = takeSlot(s, B, 'video');
		expect(s.video_holders).toEqual([A]);
		expect(s.queue).toEqual([B]);
	});
});

describe('video implies audio, and never consumes an audio slot (UX-STAGE-3)', () => {
	// Three separate assertions, because there are three distinct ways to get
	// this backwards and each fails differently.

	it('a video holder may publish audio with NO audio slots existing at all', () => {
		const s = stage({
			capacity: { max_participants: 10, max_av: 1, max_audio: 0 },
			video_holders: [A]
		});
		expect(canPublishAudio(s, A, false)).toBe(true);
		expect(holdsAudio(s, A)).toBe(false); // authorized without holding one
	});

	it('asking for an audio slot while holding video changes nothing', () => {
		const s = stage({ video_holders: [A] });
		expect(takeSlot(s, A, 'audio')).toBe(s); // identity: no allocation at all
		expect(s.audio_holders).toEqual([]);
	});

	it('a video holder unmuting is NOT queued behind the audio-only crowd', () => {
		// The most common wrong implementation: unmute enqueues a video holder
		// when audio is scarce, so they wait for something they already have.
		const s = stage({
			capacity: { max_participants: 10, max_av: 1, max_audio: 1 },
			video_holders: [A],
			audio_holders: [B],
			queue: [C]
		});
		const after = unmutedAudio(s, A);
		expect(after).toBe(s);
		expect(after.queue).toEqual([C]);
	});

	it('audio publishers are the union of both lists', () => {
		const s = stage({ video_holders: [A], audio_holders: [B] });
		expect(audioPublishers(s).sort()).toEqual([A, B]);
		expect(maxAudioPublishers(s.capacity)).toBe(4); // max_av + max_audio
	});
});

describe('mute releases the audio slot (UX-STAGE-10)', () => {
	it('hands the slot to the head of the queue', () => {
		// max_audio 1, so the queue is genuinely contended. A fixture with free
		// slots AND people queued is an impossible state — drain() would empty
		// the queue into those slots, which is correct behaviour and would make
		// the assertion meaningless.
		const s = stage({
			capacity: { max_participants: 10, max_av: 2, max_audio: 1 },
			audio_holders: [A],
			queue: [B, C]
		});
		const after = mutedAudio(s, A);
		expect(after.audio_holders).toEqual([B]);
		expect(after.queue).toEqual([C]);
	});

	it('releases even with an EMPTY queue', () => {
		// DESIGN.md flags this as deliberate and sharp: in a scarce room this is
		// how the conch gets passed, and someone may take it before you unmute.
		// Pinned by a test so it stays a decision rather than becoming an
		// accident someone "fixes" later.
		const s = stage({ audio_holders: [A], queue: [] });
		expect(mutedAudio(s, A).audio_holders).toEqual([]);
	});

	it("a VIDEO holder's mute releases nothing (the exception)", () => {
		// Their audio came from the video slot, so there is nothing to hand over
		// — and a waiting queuer must not be given something.
		const s = stage({ video_holders: [A], audio_holders: [], queue: [B] });
		const after = mutedAudio(s, A);
		expect(after.video_holders).toEqual([A]);
		expect(after.audio_holders).toEqual([]);
		expect(after.queue).toEqual([B]);
	});
});

describe('the queue is FIFO (UX-STAGE-4)', () => {
	it('two consecutive releases promote in order', () => {
		let s = stage({ audio_holders: [A, D], queue: [B, C] });
		s = releaseSlot(s, A, 'audio');
		expect(s.audio_holders).toEqual([D, B]);
		s = releaseSlot(s, D, 'audio');
		expect(s.audio_holders).toEqual([B, C]);
		expect(s.queue).toEqual([]);
	});

	it('raise-hand IS the queue entry, and lowering leaves order intact', () => {
		let s = stage({ queue: [B] });
		s = raiseHand(s, C);
		s = raiseHand(s, D);
		expect(s.queue).toEqual([B, C, D]);
		expect(queuePosition(s, C)).toBe(2);
		s = lowerHand(s, C);
		expect(s.queue).toEqual([B, D]);
		expect(isQueued(s, C)).toBe(false);
	});

	it('raising twice does not duplicate the entry', () => {
		const s = raiseHand(raiseHand(stage(), A), A);
		expect(s.queue).toEqual([A]);
	});
});

describe('lowering a cap releases in REVERSE acquisition order (AR-MEDIA-1)', () => {
	it('keeps the earliest holders and queues the latest first', () => {
		// Asserting BOTH the survivors and the queue order matters: an
		// implementation that just truncates with slice() passes the first
		// assertion and fails the second.
		const s = stage({
			capacity: { max_participants: 10, max_av: 3, max_audio: 0 },
			video_holders: [A, B, C]
		});
		const after = applyCapacity(s, { max_participants: 10, max_av: 1, max_audio: 0 });
		expect(after.video_holders).toEqual([A]);
		expect(after.queue).toEqual([C, B]);
	});

	it('an existing queuer keeps their place ahead of the displaced', () => {
		const s = stage({
			capacity: { max_participants: 10, max_av: 2, max_audio: 0 },
			video_holders: [A, B],
			queue: [D]
		});
		const after = applyCapacity(s, { max_participants: 10, max_av: 1, max_audio: 0 });
		expect(after.queue).toEqual([D, B]);
	});

	it('raising a cap promotes from the queue in the same call', () => {
		// Catches a trim-only implementation, which would leave slots free while
		// people wait for someone to release.
		const s = stage({
			capacity: { max_participants: 10, max_av: 1, max_audio: 0 },
			video_holders: [A],
			queue: [B, C]
		});
		const after = applyCapacity(s, { max_participants: 10, max_av: 3, max_audio: 0 });
		expect(after.video_holders).toEqual([A, B, C]);
		expect(after.queue).toEqual([]);
	});

	it('never evicts a PERSON when max_participants drops', () => {
		// UX-STAGE-11 gates admission, not presence. Removing someone because a
		// host changed a number is worse than a temporarily over-capacity room.
		const s = stage({ capacity: { max_participants: 5, max_av: 2, max_audio: 2 } });
		const after = applyCapacity(s, { max_participants: 1, max_av: 2, max_audio: 2 });
		expect(after.capacity.max_participants).toBe(1);
		// Admission is refused going forward...
		expect(admits(after, 3, false)).toBe(false);
		// ...but someone already here is never turned away.
		expect(admits(after, 3, true)).toBe(true);
	});
});

describe('departures and host overrides', () => {
	it('leaving releases both slots and performs both handoffs', () => {
		// One video slot and two audio, all occupied, so both handoffs are real.
		const s = stage({
			capacity: { max_participants: 10, max_av: 1, max_audio: 2 },
			video_holders: [A],
			audio_holders: [A, B],
			queue: [C, D]
		});
		const after = participantLeft(s, A);
		expect(after.video_holders).toEqual([C]);
		expect(after.audio_holders).toEqual([B, D]);
		expect(after.queue).toEqual([]);
	});

	it('leaving while QUEUED removes only you, order intact', () => {
		// The spec is silent here; a queue holding people who have left would
		// hand slots to absent participants.
		//
		// Zero capacity, so nobody is promoted and the queue's ORDER is what is
		// being tested rather than how fast it empties.
		const s = stage({ capacity: { max_participants: 10, max_av: 0, max_audio: 0 }, queue: [B, C, D] });
		expect(participantLeft(s, C).queue).toEqual([B, D]);
	});

	it('a host grant on a full stage preempts the OLDEST holder', () => {
		const s = stage({ capacity: { max_participants: 10, max_av: 1, max_audio: 0 }, video_holders: [A] });
		const after = grantSlot(s, B, 'video');
		expect(after.video_holders).toEqual([B]);
		expect(after.queue).toEqual([A]); // first out, first back in line
	});
});

describe('invariants hold across a long mixed sequence', () => {
	it('never over-caps, never double-allocates, never holds and queues at once', () => {
		// The targeted tests above check known rules; this catches the handoff
		// bugs that only appear in combination.
		let s = stage({ capacity: { max_participants: 6, max_av: 2, max_audio: 2 } });
		const people = [A, B, C, D, 'e', 'f'];
		const ops: ((state: StageState, id: string) => StageState)[] = [
			(state, id) => takeSlot(state, id, 'video'),
			(state, id) => takeSlot(state, id, 'audio'),
			(state, id) => releaseSlot(state, id, 'video'),
			(state, id) => releaseSlot(state, id, 'audio'),
			(state, id) => raiseHand(state, id),
			(state, id) => lowerHand(state, id),
			(state, id) => mutedAudio(state, id),
			(state, id) => unmutedAudio(state, id),
			(state, id) => participantLeft(state, id)
		];

		for (let i = 0; i < 60; i++) {
			const person = people[i % people.length] ?? A;
			const op = ops[(i * 7) % ops.length];
			if (op === undefined) continue;
			s = op(s, person);

			expect(s.video_holders.length).toBeLessThanOrEqual(s.capacity.max_av);
			expect(s.audio_holders.length).toBeLessThanOrEqual(s.capacity.max_audio);
			expect(new Set(s.video_holders).size).toBe(s.video_holders.length);
			expect(new Set(s.audio_holders).size).toBe(s.audio_holders.length);
			expect(new Set(s.queue).size).toBe(s.queue.length);
			for (const queued of s.queue) {
				// Queued means waiting, not holding — either kind would mean the
				// person is owed something they already have.
				expect(holdsVideo(s, queued) && holdsAudio(s, queued)).toBe(false);
			}
		}
	});
});

describe('the UX-STAGE-9 readout', () => {
	it('reports held and maximum per kind', () => {
		const s = stage({
			capacity: { max_participants: 10, max_av: 3, max_audio: 6 },
			video_holders: [A, B],
			audio_holders: [C, D, 'e', 'f']
		});
		expect(counts(s)).toEqual({
			video: { held: 2, max: 3 },
			audio: { held: 4, max: 6 }
		});
	});
});
