import { describe, expect, it } from 'vitest';
import {
	applyCapacity,
	audioPublishers,
	admits,
	canPublishAudio,
	canPublishScreen,
	counts,
	freeSlots,
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
	revokeSlot,
	selectActiveSpeakers,
	SPEAKER_HOLD_MS,
	takeSlot,
	unmutedAudio,
	type StageState,
	type VoiceLevel
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
			(state, id) => takeSlot(state, id, 'screen'),
			(state, id) => releaseSlot(state, id, 'video'),
			(state, id) => releaseSlot(state, id, 'audio'),
			(state, id) => releaseSlot(state, id, 'screen'),
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

			// The POOL is what max_av bounds, so this is the invariant that matters
			// now — asserting on video_holders alone would pass while a room sat
			// over capacity on shares.
			expect(s.video_holders.length + s.screen_holders.length).toBeLessThanOrEqual(
				s.capacity.max_av
			);
			expect(s.audio_holders.length).toBeLessThanOrEqual(s.capacity.max_audio);
			expect(new Set(s.video_holders).size).toBe(s.video_holders.length);
			expect(new Set(s.audio_holders).size).toBe(s.audio_holders.length);
			expect(new Set(s.screen_holders).size).toBe(s.screen_holders.length);
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
			screen: { held: 0 },
			audio: { held: 4, max: 6 }
		});
	});

	it('counts a share against the video pool, not beside it', () => {
		// The readout must agree with `freeSlots`, or it tells someone there is
		// room a moment before the take is refused.
		const s = stage({
			capacity: { max_participants: 10, max_av: 3, max_audio: 6 },
			video_holders: [A, B],
			screen_holders: [A]
		});
		expect(counts(s)).toEqual({
			video: { held: 3, max: 3 },
			screen: { held: 1 },
			audio: { held: 0, max: 6 }
		});
		expect(freeSlots(s, 'video')).toBe(0);
	});
});

describe('screen shares spend the max_av pool (UX-OBJ-6)', () => {
	it('a camera and a share by ONE person cost the room two', () => {
		// The whole reason `screen_holders` is a third list: a set of ids cannot
		// record the same person twice, and the capacity is genuinely two.
		let s = stage({ capacity: { max_participants: 10, max_av: 2, max_audio: 0 } });
		s = takeSlot(s, A, 'video');
		s = takeSlot(s, A, 'screen');
		expect(s.video_holders).toEqual([A]);
		expect(s.screen_holders).toEqual([A]);
		expect(freeSlots(s, 'video')).toBe(0);
		// ...so B cannot join the stage at all, despite being nobody's duplicate.
		expect(takeSlot(s, B, 'video').queue).toEqual([B]);
	});

	it('video and screen report the SAME free count, because it is one pool', () => {
		const s = stage({
			capacity: { max_participants: 10, max_av: 3, max_audio: 0 },
			video_holders: [A],
			screen_holders: [B]
		});
		expect(freeSlots(s, 'screen')).toBe(freeSlots(s, 'video'));
		expect(freeSlots(s, 'screen')).toBe(1);
	});

	it('a full pool REFUSES a share rather than queueing it', () => {
		// The sharp one. A queued screen slot would be handed over minutes later
		// to someone who cannot use it without clicking share again — the gesture
		// `getDisplayMedia` needs cannot be replayed on their behalf.
		const s = stage({
			capacity: { max_participants: 10, max_av: 1, max_audio: 0 },
			video_holders: [A]
		});
		const after = takeSlot(s, B, 'screen');
		expect(after).toBe(s); // identity: nothing allocated, nothing queued
		expect(after.queue).toEqual([]);
	});

	it('ending a share hands the freed capacity to the queue as VIDEO', () => {
		// There is no queue of screen requests to drain, so the pool's next
		// claimant is the head of the ordinary queue.
		const s = stage({
			capacity: { max_participants: 10, max_av: 1, max_audio: 0 },
			screen_holders: [A],
			queue: [B, C]
		});
		const after = releaseSlot(s, A, 'screen');
		expect(after.screen_holders).toEqual([]);
		expect(after.video_holders).toEqual([B]);
		expect(after.queue).toEqual([C]);
	});

	it('sharing a screen does NOT grant the floor', () => {
		// Deliberate: someone showing a slide has not asked to speak.
		const s = stage({ screen_holders: [A] });
		expect(canPublishAudio(s, A, false)).toBe(false);
		expect(audioPublishers(s)).toEqual([]);
	});

	it('canPublishScreen follows the holder list', () => {
		const s = stage({ video_holders: [B], screen_holders: [A] });
		expect(canPublishScreen(s, A)).toBe(true);
		// Holding video is not holding screen — the authorization gate depends on
		// these being distinct, or a camera holder could publish a share.
		expect(canPublishScreen(s, B)).toBe(false);
	});

	it('leaving ends your share and frees the pool', () => {
		const s = stage({
			capacity: { max_participants: 10, max_av: 1, max_audio: 0 },
			screen_holders: [A],
			queue: [B]
		});
		const after = participantLeft(s, A);
		expect(after.screen_holders).toEqual([]);
		expect(after.video_holders).toEqual([B]);
	});
});

describe('hosts may stop a share, but never start one', () => {
	it('granting a screen slot is a no-op', () => {
		// There is no gesture a host can perform on someone else's behalf, so a
		// granted screen slot would occupy max_av and publish nothing.
		const s = stage({ capacity: { max_participants: 10, max_av: 2, max_audio: 0 } });
		expect(grantSlot(s, A, 'screen')).toBe(s);
	});

	it('revoking a screen slot works, and drains the pool', () => {
		const s = stage({
			capacity: { max_participants: 10, max_av: 1, max_audio: 0 },
			screen_holders: [A],
			queue: [B]
		});
		const after = revokeSlot(s, A, 'screen');
		expect(after.screen_holders).toEqual([]);
		expect(after.video_holders).toEqual([B]);
	});

	it('a video grant preempts a SHARE when no video holder can yield', () => {
		// Otherwise UX-STAGE-4's escape hatch silently fails to open in a room
		// whose max_av is entirely screen shares.
		const s = stage({
			capacity: { max_participants: 10, max_av: 1, max_audio: 0 },
			screen_holders: [A]
		});
		const after = grantSlot(s, B, 'video');
		expect(after.video_holders).toEqual([B]);
		expect(after.screen_holders).toEqual([]);
		// The preempted SHARER is not queued: see takeSlot.
		expect(after.queue).toEqual([]);
	});
});

describe('lowering max_av trims the pool, shares first', () => {
	it('ends shares before it blanks a face', () => {
		// Both are over the limit, so something has to choose. A share can be put
		// back with one click; a revoked camera cannot be re-taken unilaterally
		// in a room that just got smaller.
		const s = stage({
			capacity: { max_participants: 10, max_av: 3, max_audio: 0 },
			video_holders: [A, B],
			screen_holders: [C]
		});
		const after = applyCapacity(s, { max_participants: 10, max_av: 2, max_audio: 0 });
		expect(after.screen_holders).toEqual([]);
		expect(after.video_holders).toEqual([A, B]);
		expect(after.queue).toEqual([]); // the displaced SHARER does not queue
	});

	it('falls through to video once the shares are gone, and those DO queue', () => {
		const s = stage({
			capacity: { max_participants: 10, max_av: 3, max_audio: 0 },
			video_holders: [A, B],
			screen_holders: [C]
		});
		const after = applyCapacity(s, { max_participants: 10, max_av: 1, max_audio: 0 });
		expect(after.screen_holders).toEqual([]);
		expect(after.video_holders).toEqual([A]);
		expect(after.queue).toEqual([B]);
	});
});

/**
 * The active-speaker cap (UX-STAGE-5, AR-MEDIA-6).
 *
 * Pure and node-tested, which is what AR-MEDIA-6's "selection is control-plane
 * and transport-agnostic — one implementation, one source of truth" actually
 * requires: every peer computes this from the same inputs, so agreement is a
 * property of the function rather than of a negotiation. On P2P there is no
 * forwarder to arbitrate, so if this were not deterministic two clients would
 * disagree about who the third speaker is and one would mute somebody the other
 * could hear.
 */
describe('selectActiveSpeakers', () => {
	const NOW = 1_000_000;

	/** A room where `max_audio` is generous enough for the cap to matter. */
	function roomOf(...ids: string[]): StageState {
		return {
			capacity: { max_participants: 20, max_av: 0, max_audio: 10 },
			video_holders: [],
			audio_holders: [...ids],
			screen_holders: [],
			queue: []
		};
	}

	const loud = (level: number, at = NOW): VoiceLevel => ({ level, at });

	it('is a no-op when no more people are authorized than the cap', () => {
		// The common room. Nothing here may silence somebody the stage allowed.
		const state = roomOf('a', 'b', 'c');
		expect(selectActiveSpeakers(state, new Map(), NOW)).toEqual(['a', 'b', 'c']);
	});

	it('keeps the loudest when more are authorized than the cap', () => {
		const state = roomOf('a', 'b', 'c', 'd', 'e');
		const levels = new Map([
			['a', loud(0.1)],
			['b', loud(0.9)],
			['c', loud(0.5)],
			['d', loud(0.7)],
			['e', loud(0.2)]
		]);
		expect(selectActiveSpeakers(state, levels, NOW)).toEqual(['b', 'd', 'c']);
	});

	it('holds the floor across a gap between words', () => {
		/*
		 * THE reason this function takes a clock. Speech has gaps of a few
		 * hundred milliseconds, and a selection recomputed on instantaneous
		 * loudness drops somebody mid-clause and hands their place to whoever
		 * coughed — the listener hears the first syllable of every other word.
		 */
		const state = roomOf('a', 'b', 'c', 'd');
		const levels = new Map([
			['a', loud(0.8, NOW - 400)],
			['b', loud(0.7, NOW - 300)],
			['c', loud(0.6, NOW - 200)],
			['d', loud(0.9, NOW - 5000)]
		]);
		// `d` was loudest, but five seconds ago: they have stopped talking.
		expect(selectActiveSpeakers(state, levels, NOW)).toEqual(['a', 'b', 'c']);
	});

	it('releases the floor once the hold expires', () => {
		const state = roomOf('a', 'b', 'c', 'd');
		const stale = NOW - SPEAKER_HOLD_MS - 1;
		const levels = new Map([
			['a', loud(0.9, stale)],
			['b', loud(0.1)],
			['c', loud(0.2)],
			['d', loud(0.3)]
		]);
		const selected = selectActiveSpeakers(state, levels, NOW);
		expect(selected).not.toContain('a');
		expect(selected).toEqual(['d', 'c', 'b']);
	});

	it('fills from the authorized order in a silent room, rather than gating everyone', () => {
		/*
		 * Silence must not mean "nobody may be heard", or the first person to
		 * speak after a pause is cut off for as long as it takes their level to
		 * arrive — the room would clip the start of every sentence following a
		 * lull. This is the case a naive "top N by level" gets wrong, because
		 * every level is zero.
		 */
		const state = roomOf('a', 'b', 'c', 'd', 'e');
		expect(selectActiveSpeakers(state, new Map(), NOW)).toEqual(['a', 'b', 'c']);
	});

	it('tops up with quiet people when fewer than the cap are speaking', () => {
		const state = roomOf('a', 'b', 'c', 'd');
		const levels = new Map([['c', loud(0.9)]]);
		const selected = selectActiveSpeakers(state, levels, NOW);
		expect(selected[0]).toBe('c');
		expect(selected).toHaveLength(3);
	});

	it('breaks ties deterministically, so two peers cannot disagree', () => {
		// If this were unstable, one client would gate somebody another could
		// hear — and nothing in a P2P mesh would ever reconcile them.
		const state = roomOf('a', 'b', 'c', 'd');
		const levels = new Map([
			['a', loud(0.5)],
			['b', loud(0.5)],
			['c', loud(0.5)],
			['d', loud(0.5)]
		]);
		const first = selectActiveSpeakers(state, levels, NOW);
		const second = selectActiveSpeakers(state, levels, NOW);
		expect(first).toEqual(second);
		expect(first).toEqual(['a', 'b', 'c']);
	});

	it('counts video holders as authorized, per the union rule', () => {
		// UX-STAGE-5's first half: audio publishers are video holders PLUS audio
		// holders. A cap that only looked at `audio_holders` would silence
		// somebody on camera.
		const state: StageState = {
			capacity: { max_participants: 20, max_av: 4, max_audio: 10 },
			video_holders: ['v1', 'v2'],
			audio_holders: ['a1', 'a2'],
			screen_holders: [],
			queue: []
		};
		const levels = new Map([['a2', loud(0.9)]]);
		const selected = selectActiveSpeakers(state, levels, NOW);
		expect(selected).toContain('a2');
		expect(selected).toHaveLength(3);
	});

	it('never returns somebody the stage did not authorize', () => {
		// The cap narrows; it must never widen. A level arriving from someone
		// with no slot — a stale broadcast, or a patched client — cannot buy them
		// the floor.
		const state = roomOf('a', 'b', 'c', 'd');
		const levels = new Map([['intruder', loud(1)]]);
		expect(selectActiveSpeakers(state, levels, NOW)).not.toContain('intruder');
	});
});
