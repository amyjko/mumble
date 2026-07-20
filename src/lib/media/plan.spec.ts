import { describe, expect, it } from 'vitest';
import { planMedia, type PlanInput } from './plan';
import { freshStage, takeSlot, applyCapacity, type StageState } from '$lib/model/stage';

/**
 * The desired-media solver (AR-CTRL-3, AR-MEDIA-5, UX-STAGE-3/10, UX-ROOM-1).
 *
 * Node-only, which is the point of putting this logic in a pure function: the
 * whole decision matrix — who publishes, who is connected to, at what rung — is
 * exercised without a browser, a camera or a peer connection.
 *
 * Stage states are built with the REAL `stage.ts` operations rather than
 * hand-written holder arrays, so these tests cannot drift from what the
 * application can actually produce.
 */

const ME = 'aaaaaaaa-0000-4000-8000-00000000000a';
const YOU = 'bbbbbbbb-0000-4000-8000-00000000000b';
const THIRD = 'cccccccc-0000-4000-8000-00000000000c';

/** The conch: one video slot, no audio-only slots (DESIGN.md build order step 4). */
function conch(): StageState {
	return applyCapacity(freshStage(), { max_participants: 20, max_av: 1, max_audio: 0 });
}

function input(over: Partial<PlanInput> = {}): PlanInput {
	return {
		self: ME,
		stage: conch(),
		present: [ME, YOU],
		muted: false,
		tiles: new Map(),
		...over
	};
}

describe('the >=2-present rule (AR-CTRL-3, UX-ROOM-1)', () => {
	it('a lone occupant captures nothing and connects to nobody', () => {
		// Not just a cost rule. `capture.video === false` means getUserMedia is
		// never called, so the first person into a room is never shown a camera
		// prompt for a call that is not happening — and somebody is always first.
		const plan = planMedia(input({ present: [ME], stage: takeSlot(conch(), ME, 'video') }));
		expect(plan).toEqual({
			capture: { video: false, audio: false, screen: false },
			peers: [],
			subscriptions: []
		});
	});

	it('holding a slot alone still yields nothing', () => {
		// The slot is authorization, not activation (UX-STAGE-6). Holding the
		// conch in an empty room authorizes publishing to nobody.
		const plan = planMedia(input({ present: [ME], stage: takeSlot(conch(), ME, 'video') }));
		expect(plan.capture.video).toBe(false);
	});

	it('a second arrival is what starts the session', () => {
		const plan = planMedia(input({ stage: takeSlot(conch(), ME, 'video') }));
		expect(plan.capture.video).toBe(true);
		expect(plan.peers).toEqual([YOU]);
	});

	it('counts PRESENCE, not membership', () => {
		// A room with many members and one person in it is a lone occupant. The
		// input is `present` precisely so this cannot be got wrong here.
		const plan = planMedia(input({ present: [ME] }));
		expect(plan.peers).toEqual([]);
	});
});

describe('what this client sends', () => {
	it('publishes nothing while holding no slot', () => {
		const plan = planMedia(input());
		expect(plan.capture).toEqual({ video: false, audio: false, screen: false });
	});

	it('a video holder also sends audio, without an audio slot (UX-STAGE-3)', () => {
		// The rule people get backwards. At max_audio = 0 there is no audio slot
		// to hold, so a naive implementation would publish video in silence.
		const stage = takeSlot(conch(), ME, 'video');
		expect(stage.audio_holders).toEqual([]);
		expect(planMedia(input({ stage })).capture).toEqual({ video: true, audio: true, screen: false });
	});

	it('muting silences audio but keeps the video slot (UX-STAGE-10)', () => {
		const stage = takeSlot(conch(), ME, 'video');
		const plan = planMedia(input({ stage, muted: true }));
		expect(plan.capture).toEqual({ video: true, audio: false, screen: false });
	});

	it('stops publishing when a lowered cap takes the slot away', () => {
		// AR-MEDIA-1 releases holders beyond a lowered cap. The plan must follow
		// the stage rather than remember what it was doing a moment ago.
		const held = takeSlot(conch(), ME, 'video');
		expect(planMedia(input({ stage: held })).capture.video).toBe(true);

		const lowered = applyCapacity(held, { max_participants: 20, max_av: 0, max_audio: 0 });
		expect(planMedia(input({ stage: lowered })).capture.video).toBe(false);
	});
});

describe('what this client receives', () => {
	it('subscribes to a peer holding the conch', () => {
		const stage = takeSlot(conch(), YOU, 'video');
		const plan = planMedia(input({ stage, tiles: new Map([[YOU, { deviceWidth: 540 }]]) }));
		expect(plan.subscriptions).toEqual([
			{ peer: YOU, kind: 'video', layer: 'high' },
			{ peer: YOU, kind: 'audio', layer: 'low' }
		]);
	});

	it('does not subscribe to a peer the stage does not authorize', () => {
		// The client never asks for a track the sender is not allowed to send —
		// the same holder lists the server enforces.
		const plan = planMedia(input({ present: [ME, YOU, THIRD], stage: takeSlot(conch(), YOU, 'video') }));
		expect(plan.subscriptions.filter((s) => s.peer === THIRD)).toEqual([]);
	});

	it('never subscribes to itself', () => {
		const stage = takeSlot(conch(), ME, 'video');
		const plan = planMedia(input({ stage }));
		expect(plan.subscriptions.every((s) => s.peer !== ME)).toBe(true);
		expect(plan.peers).not.toContain(ME);
	});

	it('follows the tile size, and never rounds up (AR-MEDIA-5)', () => {
		const stage = takeSlot(conch(), YOU, 'video');
		const at = (deviceWidth: number) =>
			planMedia(input({ stage, tiles: new Map([[YOU, { deviceWidth }]]) })).subscriptions.find(
				(s) => s.kind === 'video'
			)?.layer;
		expect(at(1080)).toBe('high');
		expect(at(400)).toBe('med');
		expect(at(120)).toBe('low');
		// Scale-to-fill: nearly a `high` tile still gets `med`.
		expect(at(539)).toBe('med');
	});

	it('treats an unmeasured tile as the cheapest, not the most expensive', () => {
		const stage = takeSlot(conch(), YOU, 'video');
		const plan = planMedia(input({ stage, tiles: new Map() }));
		expect(plan.subscriptions.find((s) => s.kind === 'video')?.layer).toBe('low');
	});

	it('keeps the audio subscription when a peer mutes', () => {
		// Muting "silences you without necessarily giving up a slot"
		// (UX-STAGE-10), so the holder is still authorized and simply sends
		// nothing. Dropping the subscription would renegotiate on every
		// microphone toggle in the room.
		const stage = takeSlot(conch(), YOU, 'video');
		const plan = planMedia(input({ stage, muted: true }));
		expect(plan.subscriptions.some((s) => s.peer === YOU && s.kind === 'audio')).toBe(true);
	});
});

describe('screen shares (UX-OBJ-6)', () => {
	/** A stage with room for two, so a camera and a share can coexist. */
	function roomy(): StageState {
		return applyCapacity(freshStage(), { max_participants: 20, max_av: 2, max_audio: 0 });
	}

	it('authorizes publishing when the slot is held', () => {
		const stage = takeSlot(roomy(), ME, 'screen');
		expect(planMedia(input({ stage })).capture.screen).toBe(true);
	});

	it('does NOT authorize a share for a camera holder', () => {
		// Separate slots, separate authorization. If these ever collapse, any
		// video holder could publish a share and quietly exceed max_av.
		const stage = takeSlot(roomy(), ME, 'video');
		expect(planMedia(input({ stage })).capture.screen).toBe(false);
	});

	it('subscribes to a peer’s share', () => {
		const stage = takeSlot(roomy(), YOU, 'screen');
		const plan = planMedia(input({ stage }));
		expect(plan.subscriptions.some((s) => s.peer === YOU && s.kind === 'screen')).toBe(true);
	});

	it('subscribes to the share’s SOUND under the same guard (UX-OBJ-16)', () => {
		/*
		 * Unconditionally, because whether a share has sound is not knowable from
		 * the stage — it depends on a checkbox in the sharer's own picker. A
		 * subscription for a track nobody sends costs one message; the alternative
		 * is silence that appears for some shares and not others.
		 */
		const stage = takeSlot(roomy(), YOU, 'screen');
		const plan = planMedia(input({ stage }));
		expect(plan.subscriptions.some((s) => s.peer === YOU && s.kind === 'screenaudio')).toBe(true);
	});

	it('does not subscribe to a share’s sound from a non-holder', () => {
		const stage = takeSlot(roomy(), YOU, 'video');
		expect(planMedia(input({ stage })).subscriptions.some((s) => s.kind === 'screenaudio')).toBe(
			false
		);
	});

	it('has no fourth CAPTURE field — the screen slot authorizes both tracks', () => {
		// Pinning a deliberate absence. `capture.screen` is the single
		// authorization; a `capture.screenaudio` would imply a second decision
		// that nothing makes.
		const stage = takeSlot(roomy(), ME, 'screen');
		expect(Object.keys(planMedia(input({ stage })).capture).sort()).toEqual([
			'audio',
			'screen',
			'video'
		]);
	});

	it('does not subscribe to a share nobody holds a slot for', () => {
		const stage = takeSlot(roomy(), YOU, 'video');
		const plan = planMedia(input({ stage }));
		expect(plan.subscriptions.some((s) => s.kind === 'screen')).toBe(false);
	});

	it('picks the rung from the SHARE’s size, not the sharer’s avatar', () => {
		/*
		 * The concrete bug this rules out: a share filling the canvas requested at
		 * thumbnail quality because its owner's face happens to be small.
		 */
		const stage = takeSlot(takeSlot(roomy(), YOU, 'video'), YOU, 'screen');
		const plan = planMedia(
			input({
				stage,
				tiles: new Map([[YOU, { deviceWidth: 100 }]]),
				screenTiles: new Map([[YOU, { deviceWidth: 1280 }]])
			})
		);
		expect(plan.subscriptions.find((s) => s.kind === 'screen')?.layer).toBe('high');
		// The avatar keeps its own, much smaller rung.
		expect(plan.subscriptions.find((s) => s.kind === 'video')?.layer).toBe('low');
	});

	it('treats an unmeasured share as the CHEAPEST rung, not the dearest', () => {
		// A share object exists a beat before it has been laid out. Defaulting up
		// would make every new share momentarily the most expensive thing around.
		const stage = takeSlot(roomy(), YOU, 'screen');
		const plan = planMedia(input({ stage, screenTiles: new Map() }));
		expect(plan.subscriptions.find((s) => s.kind === 'screen')?.layer).toBe('low');
	});

	it('is still nothing at all for a lone occupant', () => {
		const stage = takeSlot(roomy(), ME, 'screen');
		expect(planMedia(input({ present: [ME], stage })).capture.screen).toBe(false);
	});
});

describe('connections', () => {
	it('connects to peers publishing nothing, so a handoff is pre-warmed', () => {
		// AR-TRANSPORT-9: a connection that appears only when someone starts
		// publishing cannot be warm — negotiation would begin at exactly the
		// moment the media is wanted.
		const plan = planMedia(input({ present: [ME, YOU, THIRD] }));
		expect(plan.capture).toEqual({ video: false, audio: false, screen: false });
		expect([...plan.peers].sort()).toEqual([YOU, THIRD].sort());
	});
});
