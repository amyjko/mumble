<script lang="ts">
	import '../app.css';
	import '$lib/theme/noto-color-emoji.css';
	import favicon from '$lib/assets/favicon.svg';
	import ThemeToggle from '$lib/ui/ThemeToggle.svelte';
	import type { LayoutProps } from './$types';
	import { page } from '$app/state';
	import { onMount } from 'svelte';

	let { children }: LayoutProps = $props();

	/**
	 * Mark the document interactive.
	 *
	 * Server-rendered controls exist in the DOM before hydration attaches their
	 * handlers, so a test (or a fast human) can click one and have nothing
	 * happen. Room tests never hit this because the canvas only appears after
	 * hydration, so waiting for it is an implicit readiness check — the
	 * document pages had no equivalent, and the theme test flaked under
	 * parallel load precisely there.
	 *
	 * One attribute, set once, is cheaper than teaching every test a different
	 * per-page proxy for "ready".
	 */
	onMount(() => {
		document.documentElement.dataset['hydrated'] = 'true';
	});
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
