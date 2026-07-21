<script lang="ts">
	import type { RoomStore } from '$lib/store/room-store';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import { VIDEO_EMOJI, MIC_EMOJI, SCREEN_EMOJI } from '$lib/model/emotes';
	import {
		freeSlots,
		holdsAudio,
		holdsScreen,
		holdsVideo,
		type SlotMedia,
		type StageState
	} from '$lib/model/stage';
	import Emoji from '$lib/ui/Emoji.svelte';
	import Button from '$lib/ui/Button.svelte';
	import { stopPointer } from '$lib/ui/events';

	/**
	 * A host's grant/revoke controls for ONE other participant (UX-STAGE-4).
	 *
	 * "A host may grant, revoke, or preempt any slot directly, which is the
	 * escape hatch when the queue needs overriding." The rules for all of that
	 * already existed in `model/stage.ts` and were enforced server-side in the
	 * rule engine — what was missing was any way for a person to reach them, so
	 * the escape hatch was exercised only by tests. That is why this component
	 * adds no model, no schema, no route and no migration: it is a surface over
	 * mutations that were already there.
	 *
	 * Mounted in two places, deliberately as ONE implementation:
	 *
	 *  - on every OTHER participant's avatar, ALWAYS VISIBLE to a host. Passing
	 *    the floor is the most frequent act in a `max_av = 1` conch room, so it
	 *    cannot live two clicks deep in a menu.
	 *
	 *    Note this is deliberately unlike the avatar's own `isSelf` chrome,
	 *    which is hover-revealed (`opacity: 0` until `:hover`/`:focus-within`).
	 *    That is right for a rare cosmetic self-action like changing your own
	 *    tile shape, and wrong here for two reasons: this is frequent and often
	 *    time-critical, and hover does not exist on touch — a host on a tablet
	 *    would have no way to reach a hover-gated control at all.
	 *  - on each queue row in the stage menu, because queue ORDER is legible
	 *    nowhere else and someone waiting may be scrolled off-screen entirely,
	 *    which makes their avatar unclickable.
	 *
	 * This does not contradict EmoteBar's rule that the one always-visible bar
	 * can act only on YOU. That rule is about self-expression — the ambiguity it
	 * removed was emotes looking like something you could do TO someone. Host
	 * moderation is legitimately something you do to someone (UX-PERM-3), and
	 * hiding it would not make it less so.
	 */

	interface Props {
		store: RoomStore;
		sync: SyncClient;
		/** The participant these controls act ON — never the host themselves. */
		id: string;
		/** Their name, for labels that have to say who is being acted upon. */
		name: string;
	}

	let { store, sync, id, name }: Props = $props();

	/** Read through the pure module (AR-TEST-4): render these, never compute them. */
	const stage = $derived<StageState>({
		capacity: store.state.capacity,
		video_holders: store.state.video_holders,
		audio_holders: store.state.audio_holders,
		screen_holders: store.state.screen_holders,
		queue: store.state.queue
	});

	const hasVideo = $derived(holdsVideo(stage, id));
	const hasAudio = $derived(holdsAudio(stage, id));
	const sharing = $derived(holdsScreen(stage, id));

	/*
	 * A grant onto a full pool PREEMPTS the oldest holder, who goes to the head
	 * of the queue (stage.ts). The label says so rather than letting a host
	 * discover it by taking someone's camera away — the escape hatch has to
	 * open, but it should not open silently.
	 */
	const videoFull = $derived(freeSlots(stage, 'video') === 0);
	const audioFull = $derived(freeSlots(stage, 'audio') === 0);

	/**
	 * Grant and revoke are NOT symmetric, and the schema says so: `grant_slot`
	 * takes video or audio, `revoke_slot` also takes screen. Two functions
	 * rather than one with a union, because collapsing them is exactly what the
	 * type checker refuses — and it is right to. A host can end a share but
	 * never start one for somebody.
	 */
	function announce(ok: boolean, done: string): void {
		// UX-A11Y-3, for the acting host. A rejection announces itself already,
		// so this speaks only on success.
		if (ok) sync.announce(done);
	}

	function grant(media: 'video' | 'audio', done: string): void {
		void sync.commit({ kind: 'grant_slot', id, media }).then((ok) => {
			announce(ok, done);
		});
	}

	function revoke(media: SlotMedia, done: string): void {
		void sync.commit({ kind: 'revoke_slot', id, media }).then((ok) => {
			announce(ok, done);
		});
	}
</script>

<span class="host-slots" role="group" aria-label="Slots for {name}">
	<Button
		variant="chrome"
		shape="icon"
		pressed={hasVideo}
		label={hasVideo
			? `Revoke ${name}'s video slot`
			: videoFull
				? `Give ${name} a video slot (the stage is full, so the longest-standing holder loses theirs and goes to the front of the queue)`
				: `Give ${name} a video slot`}
		onpointerdown={stopPointer}
		onclick={() => {
			if (hasVideo) revoke('video', `Revoked ${name}'s video slot`);
			else grant('video', `Gave ${name} a video slot`);
		}}><Emoji glyph={VIDEO_EMOJI} /></Button
	>
	<Button
		variant="chrome"
		shape="icon"
		pressed={hasAudio}
		label={hasAudio
			? `Revoke ${name}'s audio slot`
			: audioFull
				? `Give ${name} an audio slot (the stage is full, so the longest-standing holder loses theirs and goes to the front of the queue)`
				: `Give ${name} an audio slot`}
		onpointerdown={stopPointer}
		onclick={() => {
			if (hasAudio) revoke('audio', `Revoked ${name}'s audio slot`);
			else grant('audio', `Gave ${name} an audio slot`);
		}}><Emoji glyph={MIC_EMOJI} /></Button
	>
	<!--
		Revoke only, and only while they are sharing. A host can never GRANT a
		screen slot: `getDisplayMedia` needs a gesture and a choice of what to
		show, neither of which anyone can perform on someone else's behalf, so
		`grantSlot` refuses a screen outright. Offering the button would be
		offering a no-op — the same reason the share button disables rather than
		queueing when the pool is full.
	-->
	{#if sharing}
		<Button
			variant="chrome"
			shape="icon"
			label="Stop {name}'s screen share"
			onpointerdown={stopPointer}
			onclick={() => {
				revoke('screen', `Stopped ${name}'s screen share`);
			}}><Emoji glyph={SCREEN_EMOJI} /></Button
		>
	{/if}
</span>

<style>
	.host-slots {
		display: flex;
		gap: var(--space-0);
		align-items: center;
	}
</style>
