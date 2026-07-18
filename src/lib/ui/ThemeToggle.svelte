<script lang="ts">
	import { getTheme, applyTheme, nextTheme, THEME_LABEL, THEME_ICON } from '$lib/theme/theme';
	import type { Theme } from '$lib/theme/theme';

	let theme = $state<Theme>(getTheme());

	function cycle(): void {
		theme = nextTheme(theme);
		applyTheme(theme);
	}
</script>

<button class="toggle" onclick={cycle} aria-label="Change theme, currently {THEME_LABEL[theme]}">
	<span aria-hidden="true">{THEME_ICON[theme]}</span>
	<span class="label">{THEME_LABEL[theme]}</span>
</button>

<style>
	.toggle {
		position: fixed;
		bottom: var(--space-3);
		left: var(--space-3);
		z-index: var(--z-chrome);
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: var(--target-min);
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface);
		color: var(--text);
		font: var(--text-sm) var(--font-ui);
		cursor: pointer;
	}
	.label {
		color: var(--text-muted);
	}
</style>
