<script lang="ts">
	import '../app.css';
	import '$lib/theme/noto-color-emoji.css';
	import favicon from '$lib/assets/favicon.svg';
	import ThemeToggle from '$lib/ui/ThemeToggle.svelte';
	import type { LayoutProps } from './$types';
	import { page } from '$app/state';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
<!--
	A room carries the theme control inside its own bottom toolbar, so the
	floating one would be a second copy of the same control two inches away.
-->
{#if !(page.route.id ?? '').startsWith('/hey/')}
	<ThemeToggle />
{/if}
