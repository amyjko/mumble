<script lang="ts">
	import { hint } from './hint.svelte';

	/**
	 * Bottom-center modifier hint. Sits above the emote bar and is
	 * pointer-transparent, so it can never intercept a gesture it is describing.
	 * aria-hidden by design — see hint.svelte.ts.
	 */
</script>

{#if hint.current !== null}
	<div class="hint-bar" aria-hidden="true">{hint.current}</div>
{/if}

<style>
	.hint-bar {
		position: fixed;
		/* Clear of the emote bar, which owns the bottom-center corner. */
		bottom: calc(var(--space-8) + var(--space-6));
		left: 50%;
		translate: -50% 0;
		z-index: var(--z-chrome);
		pointer-events: none;
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-full);
		background: var(--text);
		color: var(--surface);
		font-size: var(--text-sm);
		line-height: 1;
	}
</style>
