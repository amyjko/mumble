<script lang="ts">
	import type { Swatch } from '$lib/model/palette';

	/**
	 * Bespoke color chooser — no dependency, and no native <input type="color">
	 * either. The native control is an opaque OS dialog we cannot style, label,
	 * or keyboard-test, and it made the curated palette pointless.
	 *
	 * A set of mutually exclusive options is a RADIOGROUP, not a row of
	 * buttons: arrow keys move between swatches, the group has one tab stop
	 * (roving tabindex), and the current choice is announced.
	 */

	interface Props {
		value?: string | undefined;
		label: string;
		swatches: readonly Swatch[];
	}

	let { value = $bindable(''), label, swatches }: Props = $props();

	const index = $derived(Math.max(0, swatches.findIndex((s) => s.value === value)));

	function select(swatch: Swatch): void {
		value = swatch.value;
	}

	/**
	 * APG radiogroup keys, handled on the RADIO rather than the group: arrows
	 * wrap, Home/End jump, Space/Enter select. Keeping it on the radio is both
	 * the APG pattern and what lets the group stay a plain non-focusable
	 * container — a keydown handler on the group would demand a tabindex there
	 * and add a second, redundant tab stop.
	 */
	function onRadioKeyDown(event: KeyboardEvent, position: number): void {
		if (event.key === ' ' || event.key === 'Enter') {
			const current = swatches[position];
			if (current === undefined) return;
			event.preventDefault();
			select(current);
			return;
		}
		const last = swatches.length - 1;
		let next: number | null = null;
		if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = position === last ? 0 : position + 1;
		else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = position === 0 ? last : position - 1;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = last;
		if (next === null) return;
		const swatch = swatches[next];
		if (swatch === undefined) return;
		event.preventDefault();
		select(swatch);
		// Selection follows focus, so move focus to the newly selected swatch.
		if (event.currentTarget instanceof HTMLElement) {
			const group = event.currentTarget.parentElement;
			const target = group?.querySelectorAll('[role="radio"]')[next];
			if (target instanceof HTMLElement) target.focus();
		}
	}
</script>

<div class="swatches" role="radiogroup" aria-label={label}>
	{#each swatches as swatch, position (swatch.value)}
		{@const selected = swatch.value === value}
		<span
			role="radio"
			aria-checked={selected}
			aria-label={swatch.name}
			tabindex={position === index ? 0 : -1}
			class="swatch"
			class:selected
			style:background-color={swatch.value}
			onclick={() => {
				select(swatch);
			}}
			onkeydown={(event) => {
				onRadioKeyDown(event, position);
			}}
		>
			<!-- Selection is a ring AND a check: color alone can't carry it
			     (WCAG 1.4.1), least of all in a control made of colors. -->
			<span class="check" aria-hidden="true">{selected ? '✓' : ''}</span>
		</span>
	{/each}
</div>

<style>
	.swatches {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}
	.swatch {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--control-height);
		height: var(--control-height);
		border-radius: var(--radius-sm);
		/* Every swatch keeps a border, or the near-white one vanishes into the
		   surface behind it. */
		border: 1px solid var(--border-strong);
		cursor: pointer;
	}
	.swatch.selected {
		outline: var(--ring-width) solid var(--focus-ring);
		outline-offset: var(--ring-offset);
	}
	.check {
		/* Mix-blend so the tick stays legible on both dark and light swatches
		   without knowing the swatch color. */
		mix-blend-mode: difference;
		filter: invert(1) grayscale(1) contrast(9);
		font-size: var(--text-sm);
		line-height: 1;
	}
</style>
