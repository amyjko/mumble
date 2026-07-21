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
		onjoin: (identity: StoredIdentity, hello: string) => void;
		/**
		 * Whether this room admits by hand (UX-ID-3). Only then is a hello worth
		 * asking for — in an open room nobody would ever read it, and a field
		 * whose value is discarded is worse than no field.
		 */
		asks?: boolean;
	}

	let { onjoin, asks = false }: Props = $props();

	let hello = $state('');
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
		onjoin(createIdentity(name, emoji), hello);
	}
</script>

<!-- No cancel path: there is no anonymous-without-a-name state to fall back
     to, so Escape must not dismiss this. -->
<dialog
	bind:this={dialog}
	class="join panel panel-floating"
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

		{#if asks}
			<!-- UX-ID-2. Optional on purpose: a required message is a barrier at
			     the one moment the product promises there is none, and a host can
			     always decide on the name alone. -->
			<Field
				label="Say hello (optional)"
				bind:value={hello}
				placeholder="Who you are, or why you're here"
			/>
			<p class="hint">A host will let you in. They'll see your name and this note.</p>
		{/if}

		<Button type="submit" variant="primary" disabled={!ready}>
			{asks ? 'Ask to join' : 'Join'}
		</Button>

		<!--
			AR-AUTH-6, surfaced where it is actually decided.

			An anonymous identity is browser-bound: it lives in this browser and
			does not roam, so the same person on a laptop and a phone is two
			people to the room, and clearing storage loses the identity entirely.
			The requirement calls this an "accepted limitation, surfaced in UX
			copy" — it was accepted and structural for weeks, and surfaced
			nowhere, which meant the only people who learned it were the ones it
			had already surprised.

			Said HERE rather than in a settings page nobody visits, because this
			is the moment the choice is made, and said briefly: the person is
			trying to get into a meeting, not read a policy.
		-->
		<p class="hint boundary">
			Joining without an account keeps you to this browser — on another device you
			will arrive as someone new.
		</p>
	</form>
</dialog>

<style>
	.join {
		width: min(420px, calc(100vw - 2 * var(--space-4)));
		padding: var(--space-4);
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
	/* Sits under the action, so it reads as a footnote on the choice rather
	   than another instruction to follow before making it. */
	.boundary {
		margin-top: var(--space-2);
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
