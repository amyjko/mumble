import { SvelteMap } from 'svelte/reactivity';

/**
 * What THIS viewer has decided about each remote voice (UX-OBJ-16 × UX-AUDIO).
 *
 * A screen share's sound has had a per-viewer mute since UX-OBJ-6 landed; a
 * PERSON's voice had nothing — remote voices were a bare `<audio autoplay>` at
 * unity gain, with no volume, no mute, and no handling for a refused autoplay.
 * DESIGN.md's open items named the asymmetry and the reason for it: "a share is
 * an object with chrome and a voice has no position on the canvas yet".
 *
 * The resolution is that a voice has no position but the PERSON does. These
 * preferences are read by the off-canvas audio elements and written by the
 * controls on someone's avatar, which is the one place in the room that already
 * means "this specific human".
 *
 * PER VIEWER, NEVER SYNCHRONISED. Turning someone down is a listening choice,
 * not a moderation action: nobody else can tell, and the person themselves is
 * not told either, because "you have been muted by two people" is a fact that
 * would only ever hurt. Host controls over other people's slots exist and are
 * deliberately a different mechanism (UX-STAGE-4) — that one is about who may
 * speak to the room, this one is about what reaches one pair of ears.
 *
 * In memory only, so it resets on reload. Deliberate for now: a persisted mute
 * is a decision that outlives the meeting it was made in, and someone who
 * silenced a noisy roommate on Tuesday should not silently still be muting them
 * next week. If that turns out to be the wrong call, localStorage is the change.
 */

interface VoicePreference {
	muted: boolean;
	/** 0..1, linear on the element's own scale. */
	volume: number;
}

/**
 * `SvelteMap`, not `$state(new Map())`.
 *
 * The difference is invisible until something reads through `.get()`: `$state`
 * proxies a plain Map's identity but not its ENTRIES, so `set()` mutates
 * without notifying anyone and the control that wrote the value never
 * re-renders. Caught by the component test clicking mute and watching nothing
 * happen — which is exactly how a viewer would have found it.
 */
const preferences = new SvelteMap<string, VoicePreference>();

/**
 * Has the browser refused to start audio without a gesture?
 *
 * One flag for the room rather than one per peer: autoplay is a per-DOCUMENT
 * policy, so if one voice is refused they all are, and asking someone to
 * unblock each speaker separately would be a worse bug than the one being
 * fixed.
 *
 * Chrome exempts `MediaStream`-sourced elements from the policy, which is why
 * this has never misbehaved in the browser the E2E suite runs. Safari's
 * exemption is narrower. That is exactly the shape of thing that ships broken:
 * invisible where it is tested, and silent where it is not.
 */
let blocked = $state(false);

const DEFAULT: VoicePreference = { muted: false, volume: 1 };

export const voicePreferences = {
	/** What this viewer has chosen for one peer, or the default. */
	for(peer: string): VoicePreference {
		return preferences.get(peer) ?? DEFAULT;
	},

	setMuted(peer: string, muted: boolean): void {
		const current = preferences.get(peer) ?? DEFAULT;
		preferences.set(peer, { ...current, muted });
	},

	setVolume(peer: string, volume: number): void {
		const current = preferences.get(peer) ?? DEFAULT;
		// Clamped here rather than at each caller: a slider is one input today,
		// and the element would silently misbehave on an out-of-range value.
		preferences.set(peer, { ...current, volume: Math.min(1, Math.max(0, volume)) });
	},

	get blocked(): boolean {
		return blocked;
	},

	/** Called when an element's `play()` is refused. */
	reportBlocked(): void {
		blocked = true;
	},

	/**
	 * Called from a real click, which is the gesture the autoplay policy wants.
	 *
	 * Clearing the flag is not enough on its own — the elements have to be told
	 * to try again, which they do by reacting to this changing.
	 */
	allow(): void {
		blocked = false;
	},

	/** Forget everything, on leaving a room. */
	clear(): void {
		preferences.clear();
		blocked = false;
	}
};
