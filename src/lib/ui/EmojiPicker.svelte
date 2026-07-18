<script lang="ts">
	import Emoji from './Emoji.svelte';

	/**
	 * Camera-off face chooser (UX-AV-3). The field and its rendering already
	 * existed; only the way to choose one was missing, so everyone wore a
	 * random animal forever.
	 *
	 * A radiogroup, like SwatchPicker: a set of mutually exclusive options with
	 * arrow-key movement and a single tab stop, not a row of buttons.
	 */

	interface Props {
		value?: string | undefined;
		label: string;
		choices: readonly string[];
	}

	let { value = $bindable(''), label, choices }: Props = $props();

	const index = $derived(Math.max(0, choices.indexOf(value)));

	/** APG keys on the RADIO, so the group needs no second tab stop. */
	function onKeyDown(event: KeyboardEvent, position: number): void {
		const last = choices.length - 1;
		if (event.key === ' ' || event.key === 'Enter') {
			const current = choices[position];
			if (current === undefined) return;
			event.preventDefault();
			value = current;
			return;
		}
		let next: number | null = null;
		if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = position === last ? 0 : position + 1;
		else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = position === 0 ? last : position - 1;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = last;
		if (next === null) return;
		const choice = choices[next];
		if (choice === undefined) return;
		event.preventDefault();
		value = choice;
		if (event.currentTarget instanceof HTMLElement) {
			const target = event.currentTarget.parentElement?.querySelectorAll('[role="radio"]')[next];
			if (target instanceof HTMLElement) target.focus();
		}
	}
</script>

<div class="faces" role="radiogroup" aria-label={label}>
	{#each choices as choice, position (choice)}
		{@const selected = choice === value}
		<span
			role="radio"
			aria-checked={selected}
			aria-label={choice}
			tabindex={position === index ? 0 : -1}
			class="face"
			class:selected
			onclick={() => {
				value = choice;
			}}
			onkeydown={(event) => {
				onKeyDown(event, position);
			}}
		>
			<Emoji glyph={choice} size="24px" />
		</span>
	{/each}
</div>

<style>
	.faces {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}
	.face {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--control-height);
		height: var(--control-height);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		cursor: pointer;
	}
	.face.selected {
		border-color: var(--accent);
		outline: var(--ring-width) solid var(--focus-ring);
		outline-offset: var(--ring-offset);
	}
</style>
