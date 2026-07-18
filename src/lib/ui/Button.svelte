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
		title,
		type = 'button',
		popovertarget,
		onclick,
		onpointerdown
	}: Props = $props();
</script>

<button
	{type}
	{disabled}
	{popovertarget}
	{onclick}
	{onpointerdown}
	{title}
	class="btn"
	data-variant={variant}
	data-shape={shape}
	aria-pressed={pressed}
	aria-label={label}
>{@render children()}</button>

<style>
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
