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
	.theme-slot {
		position: fixed;
		bottom: var(--space-3);
		left: var(--space-3);
		z-index: var(--z-chrome);
	}
	.theme-slot.inline {
		display: contents;
	}
	.label {
		color: var(--text-muted);
	}
</style>
