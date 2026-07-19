<script lang="ts">
	import type { RoomStore } from '$lib/store/room-store';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import type { StoredIdentity } from '$lib/model/types';
	import type { Viewport } from './viewport.svelte';
	import EmoteBar from './EmoteBar.svelte';
	import ThemeToggle from '$lib/ui/ThemeToggle.svelte';
	import Button from '$lib/ui/Button.svelte';

	/**
	 * The one bottom toolbar.
	 *
	 * There were three floating clusters competing for the bottom of the
	 * screen: the emote bar fixed at bottom-centre, the camera cluster absolute
	 * at bottom-right, and the theme toggle fixed at bottom-left. At most
	 * window sizes they overlapped, and the emote bar — which wraps — grew
	 * straight over the other two.
	 *
	 * One bar, one row, one surface. It wraps as a whole, so growing content
	 * pushes rather than covers. This is the chrome layer ThemeToggle's comment
	 * has been waiting for.
	 */

	interface Props {
		store: RoomStore;
		sync: SyncClient;
		identity: StoredIdentity;
		viewport: Viewport;
	}

	let { store, sync, identity, viewport }: Props = $props();

	const zoomPercent = $derived(Math.round(viewport.camera.scale * 100));
	/** Within a percent of 1:1 — a readout of "100%" that is not quite 1:1 reads as broken. */
	const atActualSize = $derived(Math.abs(viewport.camera.scale - 1) < 0.005);
</script>

<div class="bottom-bar panel">
	<ThemeToggle inline />

	<span class="divider" aria-hidden="true"></span>

	<EmoteBar {store} {sync} {identity} />

	<span class="divider" aria-hidden="true"></span>

	<div class="camera">
		<!--
			Auto-fit is content-relative, so one small note zooms in until text is
			huge and a sprawling room zooms out past readable. Actual size is the
			way back to what everything was designed at; before this the only
			route was nudging +/- until the readout happened to say 100%.
		-->
		<Button
			pressed={atActualSize}
			label="Zoom to actual size (100%)"
			onclick={() => {
				viewport.resetZoom();
			}}>{zoomPercent}%</Button
		>
		<Button
			pressed={viewport.autoZoom}
			label="Auto-fit the room in view, currently {viewport.autoZoom ? 'on' : 'off'}"
			onclick={() => (viewport.autoZoom = !viewport.autoZoom)}
		>
			⤢ fit
		</Button>
	</div>
</div>

<style>
	.bottom-bar {
		position: fixed;
		bottom: var(--space-3);
		left: 50%;
		translate: -50% 0;
		z-index: var(--z-chrome);
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: center;
		gap: var(--space-2);
		max-width: calc(100vw - 2 * var(--space-3));
		padding: var(--space-1) var(--space-2);
	}
	.camera {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}
	.divider {
		width: 1px;
		align-self: stretch;
		background: var(--border);
	}
</style>
