<script lang="ts">
	import type { ImageCanvasObject } from '$lib/model/types';

	/**
	 * An uploaded image (UX-OBJ-5).
	 *
	 * Like a screen share, everything that makes this feel like an object — drag,
	 * resize, clip, z-order, fullscreen — comes from `ObjectFrame` and costs
	 * nothing here (AR-CANVAS-1: "a `<video>` bound to a MediaStream is just
	 * another node" — so is an `<img>`).
	 *
	 * The bytes live in Storage. `src` is a signed URL minted from
	 * `payload.path`, passed DOWN rather than resolved here for two reasons: a
	 * signed URL is per-viewer and expiring (not room state, exactly like a
	 * MediaStream), and keeping the mint out of the component leaves it pure —
	 * testable with a plain object URL and no live Supabase client.
	 */
	interface Props {
		object: ImageCanvasObject;
		/** Signed URL for `object.payload.path`; undefined until it is minted. */
		src?: string | undefined;
	}

	let { object, src }: Props = $props();

	/** UX-A11Y-3: the alt IS the accessible name. Never empty by construction
	    (upload seeds it from the filename), but guard the default-'' case. */
	const label = $derived(object.payload.alt.trim() === '' ? 'Image' : object.payload.alt);

	/** A src that resolves but fails to decode (deleted blob, expired URL). */
	let failed = $state(false);
	// A new src is a fresh attempt — clear a stale failure so a refreshed URL
	// can recover without remounting.
	$effect(() => {
		void src;
		failed = false;
	});
</script>

<div class="image" data-object-type="image">
	{#if src !== undefined && !failed}
		<img class="img" {src} alt={label} draggable="false" onerror={() => (failed = true)} />
	{:else}
		<!-- Undefined src is the normal first beat (the signed URL is still being
		     minted); failed is a blob that will not load. Either way, saying so
		     beats an empty box that reads as a broken object. -->
		<p class="placeholder">{failed ? `${label} could not load` : 'Loading image…'}</p>
	{/if}
</div>

<style>
	.image {
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		overflow: hidden;
		/* An image is content to look at, so it sits on a recessed ground; the
		   letterbox bars an off-aspect image leaves should read as frame, not as
		   part of the picture. Same choice ScreenshareObject makes. */
		background: var(--bg-level-1);
	}

	.img {
		width: 100%;
		height: 100%;
		/* CONTAIN, never cover: the aspect ratio is the image's, and cropping to
		   fill would hide the edges of what someone uploaded. */
		object-fit: contain;
		display: block;
	}

	.placeholder {
		margin: 0;
		padding: var(--space-3);
		text-align: center;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
</style>
