<script lang="ts">
	import type { RoomStore } from '$lib/store/room-store';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import type { StoredIdentity } from '$lib/model/types';
	import {
		EMOTE_NAMES,
		EMOTE_EMOJI,
		EMOTE_LABEL,
		HAND_EMOJI,
		AWAY_EMOJI,
		VIDEO_EMOJI,
		MIC_EMOJI,
		MUTED_EMOJI
	} from '$lib/model/emotes';
	import {
		counts as stageCounts,
		freeSlots,
		holdsVideo,
		isQueued,
		queuePosition,
		type StageState
	} from '$lib/model/stage';
	import Emoji from '$lib/ui/Emoji.svelte';
	import Button from '$lib/ui/Button.svelte';

	/**
	 * The dedicated bar for conveying emotion (UX-AV-4/5/7).
	 *
	 * The launcher used to hang off your own avatar, revealed only on hover —
	 * which made it hard to find, unreachable on touch, and easy to mistake for
	 * something you could do TO another person. A single fixed bar removes the
	 * ambiguity structurally: there is one launcher, it is always visible, and
	 * it can only ever act on you.
	 *
	 * Only the launcher lives here. Emotes still ANIMATE on your avatar — that
	 * is how everyone knows who reacted.
	 */

	interface Props {
		store: RoomStore;
		sync: SyncClient;
		identity: StoredIdentity;
	}

	let { store, sync, identity }: Props = $props();

	/** Persistent emote state is read from the store, so it survives a reload. */
	const self = $derived(store.state.participants[identity.id]);

	/**
	 * Stage state read through the pure module (AR-TEST-4): the component
	 * renders these, it does not compute them.
	 */
	const stage = $derived<StageState>({
		capacity: store.state.capacity,
		video_holders: store.state.video_holders,
		audio_holders: store.state.audio_holders,
		queue: store.state.queue,
		mode: store.state.mode
	});
	const hasVideo = $derived(holdsVideo(stage, identity.id));
	const videoFree = $derived(freeSlots(stage, 'video'));
	const audioFree = $derived(freeSlots(stage, 'audio'));
	const queued = $derived(isQueued(stage, identity.id));
	const position = $derived(queuePosition(stage, identity.id));
	const counts = $derived(stageCounts(stage));
</script>

<div class="emote-bar" role="group" aria-label="Express yourself">
	{#each EMOTE_NAMES as name (name)}
		<Button
			shape="icon"
			label={EMOTE_LABEL[name]}
			title={EMOTE_LABEL[name]}
			onclick={() => {
				sync.react(identity.id, name);
			}}><Emoji glyph={EMOTE_EMOJI[name]} size="20px" /></Button
		>
	{/each}
	<span class="divider" aria-hidden="true"></span>

	<!--
		Camera and mic (UX-STAGE-3/10). This bar is already "the one launcher
		that can only ever act on you", which is exactly where a mute control
		belongs. The labels carry the scarcity so it is legible BEFORE you bump
		into it (UX-STAGE-9), and the mic label distinguishes the two mute
		regimes: a video holder's mute releases nothing (UX-STAGE-10).
	-->
	<Button
		pressed={hasVideo}
		label={hasVideo
			? 'Turn camera off (frees a video slot)'
			: videoFree > 0
				? `Turn camera on (${String(videoFree)} of ${String(counts.video.max)} video slots free)`
				: 'No video slots free — raise your hand to queue'}
		onclick={() => {
			void sync.commit({
				kind: hasVideo ? 'release_slot' : 'take_slot',
				id: identity.id,
				media: 'video'
			});
		}}><Emoji glyph={VIDEO_EMOJI} /> camera</Button
	>
	<Button
		pressed={!(self?.muted ?? true)}
		label={self?.muted === false
			? hasVideo
				? 'Mute (keeps your video slot)'
				: 'Mute (frees your audio slot)'
			: 'Unmute'}
		onclick={() => {
			void sync.commit({ kind: 'set_muted', id: identity.id, muted: !(self?.muted ?? true) });
		}}><Emoji glyph={self?.muted === false ? MIC_EMOJI : MUTED_EMOJI} /> mic</Button
	>

	<!--
		UX-AV-6: the hand "appears only when the slot you want is unavailable —
		when one is free you simply take it, so the queue exists strictly for
		contention". Showing it always would invite queueing for something
		already available.
	-->
	{#if queued || (videoFree === 0 && audioFree === 0)}
		<Button
			label={queued ? `Lower hand (position ${String(position)} in queue)` : 'Raise hand to queue'}
			pressed={queued}
			onclick={() => {
				void sync.commit({ kind: 'set_hand', id: identity.id, raised: !queued });
			}}><Emoji glyph={HAND_EMOJI} /> hand{queued ? ` ${String(position)}` : ''}</Button
		>
	{/if}
	<Button
		label="Step away"
		pressed={self?.away ?? false}
		onclick={() => {
			void sync.commit({ kind: 'set_away', id: identity.id, away: !(self?.away ?? false) });
		}}><Emoji glyph={AWAY_EMOJI} /> away</Button
	>
</div>

<style>
	.emote-bar {
		position: fixed;
		bottom: var(--space-3);
		left: 50%;
		translate: -50% 0;
		z-index: var(--z-chrome);
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: center;
		gap: var(--space-1);
		max-width: calc(100vw - 2 * var(--space-3));
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface);
		box-shadow: var(--shadow-1);
	}
	.divider {
		width: 1px;
		align-self: stretch;
		margin: 0 var(--space-1);
		background: var(--border);
	}
</style>
