import { SvelteMap } from 'svelte/reactivity';
import type { Mutation, Point, Transform } from '$lib/model/types';
import { StoreRejection } from '$lib/model/types';
import type { RoomStore } from './room-store';
import type { EmoteName } from '$lib/model/emotes';

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
	/** Transient reactions (UX-AV-4), keyed by participant id, with a nonce so a
	 * repeat of the same emote re-triggers the animation. Never persisted. */
	readonly emotes = new SvelteMap<string, { emote: EmoteName; nonce: number }>();
	private emoteNonce = 0;
	/** Screen-reader announcement text (aria-live region — UX-A11Y-3). */
	announcement = $state('');
	private announceNonce = 0;

	/** Announce transient outcomes to assistive tech. The alternating trailing
	 * space forces aria-live to re-announce repeated identical messages. */
	announce(message: string): void {
		this.announceNonce += 1;
		this.announcement = message + (this.announceNonce % 2 === 1 ? '' : ' ');
	}

	private readonly store: RoomStore;

	constructor(store: RoomStore) {
		this.store = store;
		store.onEphemeral((message) => {
			switch (message.kind) {
				case 'drag_object':
					this.objectOverlays.set(message.id, message.transform);
					break;
				case 'drag_participant':
					this.participantOverlays.set(message.id, message.location);
					break;
				case 'drag_end':
					this.objectOverlays.delete(message.id);
					this.participantOverlays.delete(message.id);
					break;
				case 'emote':
					this.emoteNonce += 1;
					this.emotes.set(message.id, { emote: message.emote, nonce: this.emoteNonce });
					break;
			}
		});
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
				this.objectOverlays.delete(overlayId);
				this.participantOverlays.delete(overlayId);
				this.store.sendEphemeral({ kind: 'drag_end', id: overlayId });
			}
		}
	}

	/** Fire a transient reaction on your own avatar and broadcast it (UX-AV-4/7). */
	react(participantId: string, emote: EmoteName): void {
		this.emoteNonce += 1;
		this.emotes.set(participantId, { emote, nonce: this.emoteNonce });
		this.store.sendEphemeral({ kind: 'emote', id: participantId, emote });
	}

}