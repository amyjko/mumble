/**
 * Capacity, slots, and the turn-taking queue (UX-STAGE-1..11, AR-CTRL-2,
 * AR-MEDIA-1). Pure and node-tested, which AR-TEST-4 requires of exactly this
 * logic: "the capacity/queue rules must stay extractable from the components
 * that render them."
 *
 * Nothing here touches media. A slot is AUTHORIZATION, not activation
 * (UX-STAGE-6): holding one means you MAY publish, and being handed one
 * switches nothing on by itself. That is what makes the whole subsystem
 * buildable and testable before the A/V plane exists.
 *
 * Every function is total, takes state, and returns NEW state — no mutation,
 * no ambient input. Acquisition ORDER is the array index: acquiring appends,
 * releasing filters, and lowering a cap pops from the tail. That gives
 * AR-MEDIA-1's "reverse acquisition order" without timestamps, and it is
 * already the `participant_id[]` shape AR-CTRL-2 declares.
 */

/**
 * `screen` is a slot kind, but it is NOT a pool of its own: it draws from
 * `max_av` alongside `video` (UX-OBJ-6). It exists as a separate kind only
 * because a person may hold both, and a set of participant ids cannot say that
 * in one array.
 */
export type SlotMedia = 'video' | 'audio' | 'screen';

/** The kinds the QUEUE can hand out. See the note in `takeSlot`. */
type QueueableMedia = 'video' | 'audio';

export interface Capacity {
	max_participants: number;
	max_av: number;
	max_audio: number;
}

/**
 * The stage slice of room state (AR-CTRL-2). Holder lists are EXPLICIT, never
 * derived: they are the authorization fact.
 *
 * The queue is bare ids, per AR-CTRL-2's literal shape. A freed slot of either
 * kind goes to the head. That is coherent precisely because a slot is
 * authorization: being handed a video slot you did not specifically ask for
 * costs you nothing and turns nothing on.
 */
export interface StageState {
	capacity: Capacity;
	video_holders: string[];
	audio_holders: string[];
	/** Screen shares (UX-OBJ-6). Shares the `max_av` pool with video_holders. */
	screen_holders: string[];
	queue: string[];
}

export const DEFAULT_CAPACITY: Capacity = { max_participants: 20, max_av: 4, max_audio: 8 };

/** UX-STAGE-1: neither publish cap may exceed the room's own size. */
export function normalizeCapacity(capacity: Capacity): Capacity {
	const max_participants = Math.max(1, Math.floor(capacity.max_participants));
	return {
		max_participants,
		max_av: Math.min(max_participants, Math.max(0, Math.floor(capacity.max_av))),
		max_audio: Math.min(max_participants, Math.max(0, Math.floor(capacity.max_audio)))
	};
}

/**
 * AR-MEDIA-1: video slots bound video publishers — and, since UX-OBJ-6, screen
 * shares too. `max_av` is one pool spent by both.
 */
export function maxVideoPublishers(capacity: Capacity): number {
	return capacity.max_av;
}

/**
 * AR-MEDIA-1: audio publishers are video holders PLUS audio-only holders, so
 * the ceiling is the sum. `max_audio` bounds only the audio-only crowd.
 */
export function maxAudioPublishers(capacity: Capacity): number {
	return capacity.max_av + capacity.max_audio;
}

function holdersOf(state: StageState, media: SlotMedia): string[] {
	if (media === 'video') return state.video_holders;
	if (media === 'screen') return state.screen_holders;
	return state.audio_holders;
}

function limitFor(state: StageState, media: SlotMedia): number {
	return media === 'audio' ? state.capacity.max_audio : state.capacity.max_av;
}

function withHolders(state: StageState, media: SlotMedia, holders: string[]): StageState {
	if (media === 'video') return { ...state, video_holders: holders };
	if (media === 'screen') return { ...state, screen_holders: holders };
	return { ...state, audio_holders: holders };
}

/**
 * How much of a slot kind's POOL is spent.
 *
 * Video and screen spend the same one (UX-OBJ-6): `max_av` bounds their sum, so
 * publishing a camera and a share costs the room two. This is the only place
 * that fact is written down — everything else asks `freeSlots`.
 */
function used(state: StageState, media: SlotMedia): number {
	if (media === 'audio') return state.audio_holders.length;
	return state.video_holders.length + state.screen_holders.length;
}

export function holdsVideo(state: StageState, id: string): boolean {
	return state.video_holders.includes(id);
}

/** Holds an audio SLOT specifically — not the same as "may publish audio". */
export function holdsAudio(state: StageState, id: string): boolean {
	return state.audio_holders.includes(id);
}

export function holdsScreen(state: StageState, id: string): boolean {
	return state.screen_holders.includes(id);
}

/**
 * A consequence worth stating: `freeSlots(s, 'video')` and
 * `freeSlots(s, 'screen')` are ALWAYS equal, because they measure one pool.
 */
export function freeSlots(state: StageState, media: SlotMedia): number {
	return Math.max(0, limitFor(state, media) - used(state, media));
}

export function isQueued(state: StageState, id: string): boolean {
	return state.queue.includes(id);
}

/** 1-based position in the queue, or 0 when not queued. */
export function queuePosition(state: StageState, id: string): number {
	return state.queue.indexOf(id) + 1;
}

/**
 * Everyone authorized to publish audio (UX-STAGE-5): video holders ∪ audio
 * holders. The union is the rule people get backwards — a video holder
 * publishes audio without ever appearing in `audio_holders`.
 */
export function audioPublishers(state: StageState): string[] {
	return [...state.video_holders, ...state.audio_holders.filter((id) => !holdsVideo(state, id))];
}

export function canPublishVideo(state: StageState, id: string): boolean {
	return holdsVideo(state, id);
}

/** Muting silences you without necessarily giving up a slot (UX-STAGE-10). */
export function canPublishAudio(state: StageState, id: string, muted: boolean): boolean {
	if (muted) return false;
	return holdsVideo(state, id) || holdsAudio(state, id);
}

/**
 * UX-OBJ-6. Deliberately NOT part of `audioPublishers`: sharing a screen does
 * not hand you the floor. The requirement is silent on it, and the quieter
 * reading is the safer one — someone showing a slide has not asked to speak,
 * and granting it silently would be a surprise in a room where audio is scarce.
 */
export function canPublishScreen(state: StageState, id: string): boolean {
	return holdsScreen(state, id);
}

/**
 * What UX-STAGE-9 renders: "2/3 video · 4/6 audio".
 *
 * `screen` carries no `max` of its own because it has none — it spends
 * `video.max` (UX-OBJ-6). It is broken out so a readout can say how much of the
 * pool is shares rather than faces, without a second copy of the arithmetic.
 */
export function counts(state: StageState): {
	video: { held: number; max: number };
	screen: { held: number };
	audio: { held: number; max: number };
} {
	return {
		/*
		 * `held` is the whole POOL — video publishers plus screen shares —
		 * because that is what `max_av` bounds. Reporting only `video_holders`
		 * would render "1/2 video" in a room that is actually full, and the next
		 * person to click the camera would be refused by a readout that had just
		 * told them there was room.
		 */
		video: {
			held: state.video_holders.length + state.screen_holders.length,
			max: state.capacity.max_av
		},
		screen: { held: state.screen_holders.length },
		audio: { held: state.audio_holders.length, max: state.capacity.max_audio }
	};
}

/** UX-STAGE-11. Someone already present is never refused for being present. */
export function admits(state: StageState, present: number, alreadyPresent: boolean): boolean {
	if (alreadyPresent) return true;
	return present < state.capacity.max_participants;
}

/**
 * Fill free slots of one kind from the head of the queue (UX-STAGE-4).
 * Skips anyone who already holds that kind, so a stale queue entry cannot
 * consume a slot twice.
 */
function drain(state: StageState, media: QueueableMedia): StageState {
	let next = state;
	while (freeSlots(next, media) > 0 && next.queue.length > 0) {
		const [head, ...rest] = next.queue;
		if (head === undefined) break;
		next = { ...next, queue: rest };
		if (holdersOf(next, media).includes(head)) continue;
		next = withHolders(next, media, [...holdersOf(next, media), head]);
	}
	return next;
}

function enqueue(state: StageState, id: string): StageState {
	if (state.queue.includes(id)) return state;
	return { ...state, queue: [...state.queue, id] };
}

/**
 * Take a free slot, or queue when none is free (UX-STAGE-3).
 *
 * The audio case has the rule that is easiest to get backwards: a video holder
 * ALREADY publishes audio and must never consume an audio slot to do it. So
 * asking for audio while holding video is a no-op, not an allocation and not a
 * queue entry.
 */
export function takeSlot(state: StageState, id: string, media: SlotMedia): StageState {
	if (media === 'audio' && holdsVideo(state, id)) return state;
	if (holdersOf(state, media).includes(id)) return state;
	if (freeSlots(state, media) === 0) {
		/*
		 * A screen slot is REFUSED when the pool is full, never queued.
		 *
		 * The queue works because "being handed a slot you did not specifically
		 * ask for costs you nothing" — a slot is authorization, and authorization
		 * turns nothing on by itself. That reasoning does not survive contact with
		 * a screen share. Acquiring the track needs `getDisplayMedia`, which needs
		 * a user gesture that cannot be replayed on someone's behalf minutes
		 * later. So promoting a queued screen request would hand out a slot that
		 * occupies `max_av` while publishing nothing, and the person would have to
		 * click share again anyway.
		 *
		 * Refusing is the honest answer, and the UI disables the button when the
		 * pool is full rather than offering a queue that would not work.
		 */
		if (media === 'screen') return state;
		return enqueue(state, id);
	}
	const taken = withHolders(state, media, [...holdersOf(state, media), id]);
	return { ...taken, queue: taken.queue.filter((queued) => queued !== id) };
}

/** Release a slot and pass it to the head of the queue (UX-STAGE-4). */
export function releaseSlot(state: StageState, id: string, media: SlotMedia): StageState {
	if (!holdersOf(state, media).includes(id)) return state;
	const released = withHolders(
		state,
		media,
		holdersOf(state, media).filter((holder) => holder !== id)
	);
	// Ending a share frees capacity in the `max_av` POOL, so the queue head gets
	// a VIDEO slot. There is no queue of screen requests to drain — see above.
	return drain(released, media === 'screen' ? 'video' : media);
}

/** Raise-hand IS the queue entry (UX-AV-6). */
export function raiseHand(state: StageState, id: string): StageState {
	return enqueue(state, id);
}

export function lowerHand(state: StageState, id: string): StageState {
	return { ...state, queue: state.queue.filter((queued) => queued !== id) };
}

/**
 * Muting releases your audio slot (UX-STAGE-10) — unconditionally, even with
 * an empty queue, which DESIGN.md flags as a deliberate sharp edge: in a
 * scarce room that IS how the conch gets passed.
 *
 * The exception: a participant whose audio comes from a VIDEO slot has no
 * audio slot to release, so muting silences them and hands nothing to anyone.
 */
export function mutedAudio(state: StageState, id: string): StageState {
	if (holdsVideo(state, id)) return state;
	return releaseSlot(state, id, 'audio');
}

export function unmutedAudio(state: StageState, id: string): StageState {
	if (holdsVideo(state, id)) return state;
	return takeSlot(state, id, 'audio');
}

/**
 * Host grant (UX-STAGE-4's escape hatch). On a full stage this preempts the
 * OLDEST holder, who goes to the head of the queue — first out, first back.
 */
export function grantSlot(state: StageState, id: string, media: SlotMedia): StageState {
	/*
	 * A host cannot GRANT a screen slot. `getDisplayMedia` needs a gesture from
	 * the person sharing, and a choice of what to show — there is nothing a host
	 * can perform on their behalf, so a granted screen slot would sit there
	 * consuming `max_av` and publishing nothing. Revoking one works fine, since
	 * stopping needs no gesture (see `revokeSlot`).
	 */
	if (media === 'screen') return state;
	if (holdersOf(state, media).includes(id)) return state;
	let next = state;
	if (freeSlots(next, media) === 0) {
		/*
		 * Preempt within the POOL. Normally that is the oldest holder of the same
		 * kind, but a host granting video into a room whose `max_av` is entirely
		 * screen shares would then silently do nothing — and UX-STAGE-4's escape
		 * hatch has to actually open. So with no video holder to displace, the
		 * oldest share yields instead.
		 *
		 * A preempted video holder goes to the head of the queue: first out,
		 * first back. A preempted screen holder does not, per `takeSlot` — their
		 * share simply ends.
		 */
		const from: SlotMedia =
			media === 'video' && holdersOf(next, 'video').length === 0 ? 'screen' : media;
		const [oldest, ...remaining] = holdersOf(next, from);
		if (oldest === undefined) return next;
		next = withHolders(next, from, remaining);
		if (from !== 'screen') next = { ...next, queue: [oldest, ...next.queue] };
	}
	next = withHolders(next, media, [...holdersOf(next, media), id]);
	return { ...next, queue: next.queue.filter((queued) => queued !== id) };
}

export function revokeSlot(state: StageState, id: string, media: SlotMedia): StageState {
	return releaseSlot(state, id, media);
}

/**
 * Leaving releases both slots (UX-STAGE-4) and drops you from the queue.
 * Dequeuing is a decision the spec does not state: a queue holding people who
 * have left would hand slots to absent participants.
 */
export function participantLeft(state: StageState, id: string): StageState {
	let next: StageState = {
		...state,
		video_holders: state.video_holders.filter((holder) => holder !== id),
		audio_holders: state.audio_holders.filter((holder) => holder !== id),
		screen_holders: state.screen_holders.filter((holder) => holder !== id),
		queue: state.queue.filter((queued) => queued !== id)
	};
	next = drain(next, 'video');
	next = drain(next, 'audio');
	return next;
}

/**
 * Apply new capacity numbers, e.g. on a configuration switch (AR-MEDIA-1).
 *
 * Lowering a cap releases holders beyond the new limit in REVERSE ACQUISITION
 * ORDER — last to take it, first to lose it — and they go to the queue.
 * Raising a cap promotes from the queue in the same call, so a raise takes
 * effect immediately rather than waiting for someone to release.
 *
 * Note it never evicts a PERSON: max_participants gates new admissions only
 * (UX-STAGE-11). Removing someone from a room because a host changed a number
 * would be a far worse failure than a temporarily over-capacity room.
 */
export function applyCapacity(state: StageState, capacity: Capacity): StageState {
	let next: StageState = { ...state, capacity: normalizeCapacity(capacity) };

	/*
	 * The `max_av` pool is trimmed as ONE, and SCREEN SHARES YIELD FIRST.
	 *
	 * Both kinds are over the same limit, so something has to choose between
	 * them. Ending a share removes content its owner can put back with one
	 * click; blanking a face takes away the thing a person is least able to
	 * re-establish in a room that just got smaller. Within each kind it is still
	 * reverse acquisition order — last to take it, first to lose it.
	 *
	 * Displaced VIDEO holders queue for their slot back. Displaced screen
	 * holders do not, for the reason spelled out in `takeSlot`.
	 */
	const screens = [...next.screen_holders];
	const videos = [...next.video_holders];
	const displacedVideo: string[] = [];
	while (screens.length + videos.length > next.capacity.max_av && screens.length > 0) {
		screens.pop();
	}
	while (screens.length + videos.length > next.capacity.max_av && videos.length > 0) {
		const last = videos.pop();
		if (last === undefined) break;
		displacedVideo.push(last);
	}
	next = { ...next, screen_holders: screens, video_holders: videos };
	if (displacedVideo.length > 0) next = { ...next, queue: [...next.queue, ...displacedVideo] };

	const audio = [...next.audio_holders];
	const displacedAudio: string[] = [];
	while (audio.length > next.capacity.max_audio) {
		const last = audio.pop();
		if (last === undefined) break;
		displacedAudio.push(last);
	}
	next = { ...next, audio_holders: audio };
	if (displacedAudio.length > 0) next = { ...next, queue: [...next.queue, ...displacedAudio] };

	next = drain(next, 'video');
	next = drain(next, 'audio');
	return next;
}

/** A stage with nothing allocated, for a fresh room. */
export function freshStage(capacity: Capacity = DEFAULT_CAPACITY): StageState {
	return {
		capacity: normalizeCapacity(capacity),
		video_holders: [],
		audio_holders: [],
		screen_holders: [],
		queue: []
	};
}
