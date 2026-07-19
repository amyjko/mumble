<script lang="ts">
	import { getTheme, applyTheme, nextTheme, THEME_LABEL, THEME_ICON } from '$lib/theme/theme';
	import type { Theme } from '$lib/theme/theme';
	import Button from './Button.svelte';

	interface Props {
		/**
		 * Render bare, for a caller that owns placement. The fixed wrapper was
		 * always marked temporary — the room's bottom toolbar is the chrome
		 * layer it was waiting for.
		 */
		inline?: boolean;
	}

	let { inline = false }: Props = $props();

	let theme = $state<Theme>(getTheme());

	function cycle(): void {
		theme = nextTheme(theme);
		applyTheme(theme);
	}
</script>

<!--
	One element either way. `display: contents` when inline, so the wrapper adds
	no box and the bottom toolbar lays the button out directly — a snippet with
	two render sites would read better but trips no-confusing-void-expression.
-->
<div class="theme-slot" class:inline>
	<Button onclick={cycle} label="Change theme, currently {THEME_LABEL[theme]}">
		<span aria-hidden="true">{THEME_ICON[theme]}</span>
		<span class="label">{THEME_LABEL[theme]}</span>
	</Button>
</div>

<style>
	/*
	 * NORMAL FLOW, not fixed.
	 *
	 * Fixed chrome suits the room, which fills the viewport and never scrolls.
	 * The only pages that render this wrapper are the landing page and /new —
	 * documents that DO scroll — where a fixed badge sat permanently on top of
	 * the text and, at phone widths, covered a feature heading outright. The
	 * room carries its own copy inside the bottom toolbar (inline), so nothing
	 * still needs this pinned.
	 */
	.theme-slot {
		padding: var(--space-6) var(--space-4);
	}
	.theme-slot.inline {
		display: contents;
	}
	.label {
		color: var(--text-muted);
	}
</style>
