<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The one button in the product (AR-STYLE-1). Every control surface — room
	 * chrome, object chrome, timer controls, chat compose, theme toggle —
	 * renders through this, so size, focus ring, pressed state, and typography
	 * are defined once instead of thirty times.
	 *
	 * Callers never pass color or font: variants name an INTENT and the
	 * component resolves it to tokens. That is what keeps no-raw-color.spec.ts
	 * honest as the surface grows.
	 */

	/**
	 * Every optional prop spells `| undefined` explicitly: the project runs
	 * exactOptionalPropertyTypes, under which `variant?: 'a' | 'b'` REFUSES an
	 * explicit undefined. Without this, callers could not forward their own
	 * optional props through — which is the normal thing to want from a shared
	 * primitive, so the type has to permit it.
	 */
	interface Props {
		children: Snippet;
		/** Visual intent. `chrome` is the dark circular badge on canvas objects. */
		variant?: 'secondary' | 'primary' | 'chrome' | undefined;
		/** `icon` is square and glyph-only, and therefore requires `label`. */
		shape?: 'text' | 'icon' | undefined;
		/**
		 * Present makes this a toggle and drives aria-pressed; absent omits the
		 * attribute entirely, leaving a plain button. One prop, both semantics.
		 */
		pressed?: boolean | undefined;
		disabled?: boolean | undefined;
		/** Accessible name. Required when the content is a bare glyph. */
		label?: string | undefined;
		/**
		 * Tooltip text. Defaults to `label`, so every control that already
		 * names itself for assistive tech explains itself visually too.
		 * Pass `null` for the rare control whose meaning is fully in its text.
		 */
		tooltip?: string | null | undefined;
		title?: string | undefined;
		type?: 'button' | 'submit' | undefined;
		/** Wires this button to a Popover by id (see Popover.svelte). */
		popovertarget?: string | undefined;
		onclick?: ((event: MouseEvent) => void) | undefined;
		onpointerdown?: ((event: PointerEvent) => void) | undefined;
	}

	let {
		children,
		variant = 'secondary',
		shape = 'text',
		pressed,
		disabled = false,
		label,
		tooltip,
		title,
		type = 'button',
		popovertarget,
		onclick,
		onpointerdown
	}: Props = $props();

	/**
	 * A bespoke tooltip rather than `title`.
	 *
	 * The native one appears only on hover, only after a delay a user cannot
	 * predict, never on keyboard focus, and cannot be styled — so a
	 * keyboard-only user got no explanation of any icon control in the product.
	 * This one shows on hover AND focus, matches the design tokens, and is
	 * clamped into the viewport.
	 *
	 * aria-hidden, deliberately: the text is the button's accessible NAME
	 * already, so exposing it again makes a screen reader say it twice.
	 */
	const tipText = $derived(tooltip === null ? null : (tooltip ?? label ?? null));

	let button = $state<HTMLButtonElement | null>(null);
	let tip = $state<HTMLElement | null>(null);
	let open = $state(false);
	let position = $state({ x: 0, y: 0 });

	const GAP = 6;
	const EDGE = 8;

	function place(): void {
		if (button === null || tip === null) return;
		const anchor = button.getBoundingClientRect();
		const box = tip.getBoundingClientRect();
		// Above by default; below when there is no room, so a control at the top
		// of the window does not get a tooltip hanging off-screen.
		const above = anchor.top - box.height - GAP;
		const y = above >= EDGE ? above : anchor.bottom + GAP;
		// Clamp horizontally: chrome sits at the very edges of the canvas, so a
		// centred tooltip on an edge control would overflow every time.
		const centred = anchor.left + anchor.width / 2 - box.width / 2;
		const maxX = window.innerWidth - box.width - EDGE;
		const x = Math.max(EDGE, Math.min(centred, Math.max(EDGE, maxX)));
		position = { x, y };
	}

	function show(): void {
		if (tipText === null || disabled) return;
		open = true;
	}

	function hide(): void {
		open = false;
	}

	// Measure AFTER the tip is in the DOM: its size depends on its text, so
	// placing it from the anchor alone would mis-clamp every long label.
	$effect(() => {
		if (open) place();
	});

	function onKeyDown(event: KeyboardEvent): void {
		// Escape dismisses without moving focus (WCAG 1.4.13).
		if (event.key === 'Escape' && open) hide();
	}
</script>

<svelte:window onkeydown={onKeyDown} onresize={hide} onscroll={hide} />

<button
	bind:this={button}
	{type}
	{disabled}
	{popovertarget}
	onclick={(event: MouseEvent) => {
		// Dismiss on activation: the tooltip described what the button WOULD do,
		// and leaving it up over a changed control describes the past.
		hide();
		onclick?.(event);
	}}
	{onpointerdown}
	{title}
	class="btn"
	data-variant={variant}
	data-shape={shape}
	aria-pressed={pressed}
	aria-label={label}
	onpointerenter={show}
	onpointerleave={hide}
	onfocusin={show}
	onfocusout={hide}
>{@render children()}</button>
{#if open && tipText !== null}
	<span
		bind:this={tip}
		class="tip"
		aria-hidden="true"
		style:left="{position.x}px"
		style:top="{position.y}px">{tipText}</span
	>
{/if}

<style>
	.tip {
		position: fixed;
		z-index: var(--z-tooltip);
		max-width: 22rem;
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		font-family: var(--font-ui);
		font-size: var(--text-xs);
		line-height: 1.3;
		box-shadow: var(--shadow-1);
		/* Never intercepts the gesture it is describing. */
		pointer-events: none;
	}
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		min-height: var(--control-height);
		/* Both dimensions: WCAG 2.2 §2.5.8 is a 24×24 target, and setting only
		   min-height (as the hand-rolled buttons did) leaves `×` controls
		   narrower than the minimum. */
		min-width: var(--target-min);
		padding: 0 var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		color: var(--text);
		/* Longhand, never the `font:` shorthand — the shorthand resets
		   line-height, which is why visually identical buttons had different
		   line boxes before this component existed. */
		font-family: var(--font-ui);
		font-size: var(--text-sm);
		line-height: 1;
		cursor: pointer;
	}

	/* Ring comes from the global :focus-visible rule in app.css (one width, one
	   token, follows border-radius). Nothing here may override it. */

	/*
	 * Variant and shape are DATA ATTRIBUTES, not classes. As classes they would
	 * be words like `text` and `primary` in the global class namespace of every
	 * button in the app — `.btn.text` immediately collided with the chat log's
	 * own `.text` message span and broke a `.chat .text` selector in a test.
	 * A shared primitive must not squat on generic names.
	 */
	.btn[data-variant='primary'],
	.btn[aria-pressed='true'] {
		background: var(--accent);
		color: var(--accent-contrast);
		border-color: var(--accent);
	}

	.btn[data-variant='chrome'] {
		background: var(--text);
		color: var(--surface);
		border-color: transparent;
		border-radius: var(--radius-full);
	}

	.btn[data-shape='icon'] {
		padding: 0;
		width: var(--control-height);
		height: var(--control-height);
		min-width: var(--control-height);
	}

	.btn:disabled {
		/* WCAG 1.4.3 exempts inactive components from contrast; the disabled
		   state is never the only signal (the action is also unavailable). */
		opacity: 0.45;
		cursor: default;
	}

	.btn:not(:disabled):hover {
		border-color: var(--border-strong);
	}
</style>
