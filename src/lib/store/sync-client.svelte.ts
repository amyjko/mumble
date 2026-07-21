import { SvelteMap } from 'svelte/reactivity';
import type { Mutation, Point, Transform } from '$lib/model/types';
import { StoreRejection } from '$lib/model/types';
import type { RoomStore } from './room-store';
import type { EmoteName } from '$lib/model/emotes';
import { Interpolator } from '$lib/canvas/interpolate';

/**
 * Drive the interpolation loop (AR-BACKEND-5).
 *
 * Injected so a test can step the clock by hand: `requestAnimationFrame` does
 * not run in the node project, and a spec that has to wait real frames to
 * assert on smoothing is a slow test that measures the harness.
 */
export interface Frames {
	request: (callback: (now: number) => void) => number;
	cancel: (handle: number) => void;
}

/**
 * The three things this class asks of a store.
 *
 * Narrower than `RoomStore` on purpose: it is the honest dependency, and it is
 * what lets a unit test supply a double at all. Type assertions are banned in
 * this project, so "just cast a partial store" is not available — and that
 * constraint is doing its job here, because the alternative it forced is a
 * declaration of what is actually used.
 */
export type SyncBackend = Pick<RoomStore, 'commit' | 'sendEphemeral' | 'onEphemeral'>;

const browserFrames: Frames = {
	request: (callback) =>
		typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : 0,
	cancel: (handle) => {
		if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
	}
};

/**
 * `prefers-reduced-motion` (UX-A11Y-4) turns smoothing off entirely, leaving
 * exactly the previous behaviour: deltas apply as they arrive.
 *
 * This IS non-essential motion. The object's movement is the content; easing
 * between two reported positions is presentation, and the requirement says all
 * non-essential motion goes.
 */
function prefersReducedMotion(): boolean {
	if (typeof matchMedia !== 'function') return false;
	return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** One in-flight reaction. `key` is unique per reaction, not per participant. */
export interface Reaction {
	key: number;
	participantId: string;
	emote: EmoteName;
}

/**
 * The optimistic layer (AR-SYNC-2), store-agnostic: overlays apply instantly
 * (UX-QOS-1), commits confirm or visibly revert (UX-PERM-4). Overlays also
 * carry peers' in-flight drags arriving on the ephemeral channel. The
 * Supabase store reuses this class untouched.
 */
export class SyncClient {
	/** In-flight object transforms (own drag or a peer's), keyed by object id. */
	readonly objectOverlays = new SvelteMap<string, Transform>();
	/** In-flight participant locations, keyed by participant id. */
	readonly participantOverlays = new SvelteMap<string, Point>();
	/** Last rejection, for surfacing in UI; cleared on the next success. */
	lastRejection = $state<string | null>(null);
	/**
	 * Transient reactions in flight (UX-AV-4). A LIST, not one-per-participant:
	 * reactions are a burst medium — clicking three times should show three
	 * emoji, and two people reacting at once should show both. Keeping a single
	 * current emote per participant silently swallowed every reaction but the
	 * last. Each entry expires on its own timer. Never persisted.
	 */
	reactions = $state<Reaction[]>([]);
	private reactionKey = 0;
	private static readonly REACTION_MS = 1600;
	/** Screen-reader announcement text (aria-live region — UX-A11Y-3). */
	announcement = $state('');
	private announceNonce = 0;

	/** Announce transient outcomes to assistive tech. The alternating trailing
	 * space forces aria-live to re-announce repeated identical messages. */
	announce(message: string): void {
		this.announceNonce += 1;
		this.announcement = message + (this.announceNonce % 2 === 1 ? '' : ' ');
	}

	private readonly store: SyncBackend;

	/**
	 * Peers' drags, smoothed (AR-BACKEND-5).
	 *
	 * Only REMOTE traffic reaches this: neither store echoes to the sender
	 * (Supabase Broadcast defaults to `self: false`, and BroadcastChannel never
	 * delivers to the sending context), and local drags write to the overlay
	 * maps directly from the gesture. So your own drag follows the pointer
	 * exactly, as it must, and only the 20Hz stream from someone else is eased.
	 */
	private readonly interpolator = new Interpolator();
	private readonly frames: Frames;
	private frameHandle: number | null = null;
	/**
	 * The last full transform per object, so smoothing only touches x/y.
	 *
	 * `SvelteMap` because this file is a rune module and the project bans plain
	 * mutable Maps here (svelte/prefer-svelte-reactivity). Nothing reads this one
	 * from a template — it is bookkeeping for `tick` — but a blanket rule beats
	 * per-case judgement about which Map will one day be read reactively.
	 */
	private readonly objectShapes = new SvelteMap<string, Transform>();
	private readonly smooth: boolean;

	constructor(store: SyncBackend, frames: Frames = browserFrames, smooth = !prefersReducedMotion()) {
		this.store = store;
		this.frames = frames;
		this.smooth = smooth;
		store.onEphemeral((message) => {
			switch (message.kind) {
				case 'drag_object':
					this.objectShapes.set(message.id, message.transform);
					if (!this.smooth) {
						this.objectOverlays.set(message.id, message.transform);
						break;
					}
					// Show something immediately; the loop takes over from here.
					if (!this.objectOverlays.has(message.id)) {
						this.objectOverlays.set(message.id, message.transform);
					}
					this.interpolator.towards(message.id, {
						x: message.transform.x,
						y: message.transform.y
					});
					this.tick();
					break;
				case 'drag_participant':
					if (!this.smooth) {
						this.participantOverlays.set(message.id, message.location);
						break;
					}
					if (!this.participantOverlays.has(message.id)) {
						this.participantOverlays.set(message.id, message.location);
					}
					this.interpolator.towards(message.id, message.location);
					this.tick();
					break;
				case 'drag_end':
					/*
					 * NOT an immediate delete when smoothing.
					 *
					 * The rendered position may still be catching up, and dropping
					 * the overlay here snaps the object to its settled transform —
					 * trading twenty small steps for one visible jump, which would
					 * defeat the whole point. `end` returns false when the track
					 * has already arrived (or never existed), and only then is
					 * there nothing left to wait for.
					 */
					if (!this.smooth || !this.interpolator.end(message.id)) {
						this.clearOverlay(message.id);
					}
					break;
				case 'emote':
					this.addReaction(message.id, message.emote);
					break;
			}
		});
	}

	/** Run the smoothing loop while anything is in flight, and not a frame longer. */
	private tick(): void {
		if (this.frameHandle !== null) return;
		this.frameHandle = this.frames.request((now) => {
			this.frameHandle = null;
			for (const { id, at, done } of this.interpolator.advance(now)) {
				if (done) {
					// Arrived after their drag ended: hand back to settled state.
					this.clearOverlay(id);
					continue;
				}
				const shape = this.objectShapes.get(id);
				if (shape !== undefined) this.objectOverlays.set(id, { ...shape, x: at.x, y: at.y });
				if (this.participantOverlays.has(id)) this.participantOverlays.set(id, { ...at });
			}
			if (this.interpolator.size > 0) this.tick();
		});
	}

	private clearOverlay(id: string): void {
		this.objectOverlays.delete(id);
		this.participantOverlays.delete(id);
		this.objectShapes.delete(id);
	}

	/**
	 * Stop smoothing something because WE are now moving it.
	 *
	 * Two people can drag the same object at once; without this, their stale
	 * deltas would fight the local pointer for the same overlay entry.
	 */
	takeOver(id: string): void {
		this.interpolator.forget(id);
		this.objectShapes.delete(id);
	}

	/**
	 * Optimistic commit: the overlay is already showing the desired result;
	 * on confirm the settled state carries it, on rejection the overlay drops
	 * and the object visibly snaps back (UX-PERM-4).
	 */
	async commit(mutation: Mutation, overlayId?: string): Promise<boolean> {
		try {
			await this.store.commit(mutation);
			this.lastRejection = null;
			return true;
		} catch (error) {
			this.lastRejection =
				error instanceof StoreRejection ? error.message : 'Something went wrong';
			// UX-PERM-4's visible revert must be perceivable without vision too.
			this.announce(`Change rejected: ${this.lastRejection}`);
			return false;
		} finally {
			if (overlayId !== undefined) {
				// Also drops any smoothing track: our settled value wins over a
				// peer's in-flight one, and leaving the track would let it keep
				// writing to an overlay we just cleared.
				this.interpolator.forget(overlayId);
				this.clearOverlay(overlayId);
				this.store.sendEphemeral({ kind: 'drag_end', id: overlayId });
			}
		}
	}

	/** Fire a transient reaction on your own avatar and broadcast it (UX-AV-4/7). */
	react(participantId: string, emote: EmoteName): void {
		this.addReaction(participantId, emote);
		this.store.sendEphemeral({ kind: 'emote', id: participantId, emote });
	}

	/**
	 * Add one reaction and schedule its own removal. The key is unique per
	 * reaction so repeats of the same emote are distinct DOM nodes and each
	 * animates from its own start, rather than restarting a shared one.
	 */
	private addReaction(participantId: string, emote: EmoteName): void {
		this.reactionKey += 1;
		const key = this.reactionKey;
		this.reactions = [...this.reactions, { key, participantId, emote }];
		setTimeout(() => {
			this.reactions = this.reactions.filter((r) => r.key !== key);
		}, SyncClient.REACTION_MS);
	}

	/** The reactions currently floating above one participant. */
	reactionsFor(participantId: string): Reaction[] {
		return this.reactions.filter((r) => r.participantId === participantId);
	}

}