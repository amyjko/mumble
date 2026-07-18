<script lang="ts">
	import { getTheme, applyTheme, nextTheme, THEME_LABEL, THEME_ICON } from '$lib/theme/theme';
	import type { Theme } from '$lib/theme/theme';
	import Button from './Button.svelte';

	let theme = $state<Theme>(getTheme());

	function cycle(): void {
		theme = nextTheme(theme);
		applyTheme(theme);
	}
</script>

<!--
	The fixed positioning here is temporary: ChromeLayer takes over placement of
	all floating chrome later in this phase, at which point this wrapper goes.
-->
<div class="theme-slot">
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
	.label {
		color: var(--text-muted);
	}
</style>
