<script lang="ts">
	import type { Snippet } from 'svelte';
	import Button from './Button.svelte';

	/**
	 * A chrome menu built on the native Popover API.
	 *
	 * Chosen over <details name> and a hand-rolled store because it is the only
	 * option that solves BOTH of this round's dialog complaints with no JS:
	 * `popover="auto"` gives light-dismiss (click outside), Escape, and mutual
	 * exclusion — opening one auto popover closes any other — AND it renders in
	 * the top layer, so a menu can never be occluded by other floating chrome.
	 * Support floor (Chrome 114 / Safari 17 / FF 125) is earlier than
	 * `details name=`.
	 *
	 * Positioning is explicit rather than CSS anchor positioning, which is
	 * Chromium-only. `--chrome-top-drop` is measured from the real chrome
	 * height, so a toolbar that has wrapped onto two rows still pushes its
	 * menus clear instead of overlapping itself.
	 */

	interface Props {
		/** Stable DOM id — the invoker references it via popovertarget. */
		id: string;
		label: string;
		anchor?: 'top-start' | 'top-end' | 'bottom-center' | undefined;
		children: Snippet;
		/** Optional richer trigger content (e.g. the room title). */
		trigger?: Snippet | undefined;
	}

	let { id, label, anchor = 'top-start', children, trigger }: Props = $props();

	let open = $state(false);

	/**
	 * `ontoggle` on a plain element is typed as a generic Event, and `as` is
	 * banned — so narrow with instanceof rather than asserting. ToggleEvent is
	 * available wherever the Popover API is.
	 */
	function onToggle(event: Event): void {
		open = event instanceof ToggleEvent && event.newState === 'open';
	}
</script>

<Button popovertarget={id} pressed={open}>
	{#if trigger}{@render trigger()}{:else}{label}{/if}
	<!-- The open/closed affordance these menus previously lacked entirely. -->
	<span class="chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
</Button>

<div {id} popover="auto" class="popover {anchor}" aria-label={label} ontoggle={onToggle}>
	{@render children()}
</div>

<style>
	.popover {
		position: fixed;
		margin: 0;
		inset: auto;
		/* Never wider than the viewport: the old fixed 260px menus overflowed
		   the right edge on narrow windows and became unreachable. */
		width: min(320px, calc(100vw - 2 * var(--space-3)));
		max-height: calc(100vh - 2 * var(--space-3));
		overflow: auto;
		padding: var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface);
		color: var(--text);
		box-shadow: var(--shadow-2);
	}
	.popover.top-start {
		top: var(--chrome-top-drop, var(--space-8));
		left: var(--space-3);
	}
	.popover.top-end {
		top: var(--chrome-top-drop, var(--space-8));
		right: var(--space-3);
	}
	.popover.bottom-center {
		bottom: var(--space-8);
		left: 50%;
		translate: -50% 0;
	}
	.chevron {
		color: inherit;
		font-size: var(--text-xs);
	}
</style>
