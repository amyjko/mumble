<script lang="ts">
	import type { StoredIdentity } from '$lib/model/types';
	import { AVATAR_EMOJI, createIdentity, suggestedEmoji } from '$lib/model/identity';
	import Button from './Button.svelte';
	import Field from './Field.svelte';
	import EmojiPicker from './EmojiPicker.svelte';

	/**
	 * Ask who you are before joining (UX-ID-1: joining may be anonymous — no
	 * account required — but **a name is required**).
	 *
	 * Previously a name was invented (`guest-473`) and never requested, and
	 * `saveIdentity` was exported but never called, so nothing could change it.
	 * A generated label is not a name anyone chose, which is the whole point of
	 * the requirement: anonymity is about not needing an account, not about
	 * being unidentifiable to the room.
	 *
	 * A modal <dialog>: joining is genuinely blocking, and it puts the prompt in
	 * the top layer above all canvas chrome.
	 */

	interface Props {
		onjoin: (identity: StoredIdentity) => void;
	}

	let { onjoin }: Props = $props();

	let name = $state('');
	let emoji = $state(suggestedEmoji());
	let dialog = $state<HTMLDialogElement | null>(null);

	const ready = $derived(name.trim() !== '');

	$effect(() => {
		const el = dialog;
		if (el !== null && !el.open) el.showModal();
	});

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		if (!ready) return;
		onjoin(createIdentity(name, emoji));
	}
</script>

<!-- No cancel path: there is no anonymous-without-a-name state to fall back
     to, so Escape must not dismiss this. -->
<dialog
	bind:this={dialog}
	class="join"
	aria-label="Choose how you appear"
	oncancel={(event) => {
		event.preventDefault();
	}}
>
	<form onsubmit={submit}>
		<h2>Who are you?</h2>
		<p class="lede">No account needed — just a name others will see.</p>

		<Field label="Your name" bind:value={name} placeholder="e.g. Amy" />

		<fieldset>
			<legend>Your face</legend>
			<p class="hint">Shown when your camera is off.</p>
			<EmojiPicker label="Your face" bind:value={emoji} choices={AVATAR_EMOJI} />
		</fieldset>

		<Button type="submit" variant="primary" disabled={!ready}>Join</Button>
	</form>
</dialog>

<style>
	.join {
		width: min(420px, calc(100vw - 2 * var(--space-4)));
		padding: var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface);
		color: var(--text);
		box-shadow: var(--shadow-2);
	}
	.join::backdrop {
		background: var(--bg-canvas);
		opacity: 0.85;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	h2 {
		margin: 0;
		font-size: var(--text-lg);
	}
	.lede,
	.hint {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	fieldset {
		margin: 0;
		padding: 0;
		border: none;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	legend {
		padding: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
</style>
