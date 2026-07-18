<script lang="ts">
	import type { RoomStore } from '$lib/store/room-store';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import type { StoredIdentity } from '$lib/model/types';
	import { EMOTE_NAMES, EMOTE_EMOJI, EMOTE_LABEL } from '$lib/model/emotes';
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
</script>

<div class="emote-bar" role="group" aria-label="Express yourself">
	{#each EMOTE_NAMES as name (name)}
		<Button
			shape="icon"
			label={EMOTE_LABEL[name]}
			title={EMOTE_LABEL[name]}
			onclick={() => {
				sync.react(identity.id, name);
			}}>{EMOTE_EMOJI[name]}</Button
		>
	{/each}
	<span class="divider" aria-hidden="true"></span>
	<!-- Persistent states (UX-AV-5) read as toggles, unlike the transient ones. -->
	<Button
		pressed={self?.raised_hand ?? false}
		onclick={() => {
			void sync.commit({ kind: 'set_hand', id: identity.id, raised: !(self?.raised_hand ?? false) });
		}}>✋ hand</Button
	>
	<Button
		pressed={self?.away ?? false}
		onclick={() => {
			void sync.commit({ kind: 'set_away', id: identity.id, away: !(self?.away ?? false) });
		}}>💤 away</Button
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
