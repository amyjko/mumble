<script lang="ts">
	import type { ImageCanvasObject } from '$lib/model/types';
	import type { SyncClient } from '$lib/store/sync-client.svelte';

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
	 *
	 * Above the picture sits an always-visible caption carrying the alt text
	 * (UX-A11Y-3): editable in place for anyone with edit permission, read-only
	 * for everyone else, so the description is visible for reference either way.
	 */
	interface Props {
		object: ImageCanvasObject;
		sync: SyncClient;
		/** Whether this viewer may change the description (UX-PERM-1). */
		editable: boolean;
		/** Signed URL for `object.payload.path`; undefined until it is minted. */
		src?: string | undefined;
		/** The URL failed to load; Room decides whether to re-mint it (UX-OBJ-5). */
		onexpired?: ((path: string) => void) | undefined;
	}

	let { object, sync, editable, src, onexpired }: Props = $props();

	/** UX-A11Y-3: the alt IS the picture's accessible name. Never empty by
	    construction (upload seeds it from the filename), but guard the '' case. */
	const label = $derived(object.payload.alt.trim() === '' ? 'Image' : object.payload.alt);

	// The caption's draft. Seeded from the authoritative alt and kept in step with
	// it — including a remote edit or a rejected commit's revert — but never while
	// this viewer is mid-edit, or their typing would be yanked out from under them.
	// Only the INITIAL value is wanted here; the effect below reconciles later
	// changes (a remote edit, or a rejected commit's revert) when not mid-edit.
	// svelte-ignore state_referenced_locally
	let draft = $state(object.payload.alt);
	let input = $state<HTMLInputElement | null>(null);
	$effect(() => {
		const stored = object.payload.alt;
		if (input === null || document.activeElement !== input) draft = stored;
	});

	function commit(): void {
		const next = draft.trim();
		if (next === object.payload.alt) return;
		void sync.commit({ kind: 'set_image_alt', id: object.id, alt: next });
		sync.announce('Image description updated');
	}
	function onKeyDown(event: KeyboardEvent): void {
		if (event.key === 'Enter') {
			event.preventDefault();
			input?.blur(); // blur commits
		} else if (event.key === 'Escape') {
			event.preventDefault();
			draft = object.payload.alt; // abandon the edit; blur's commit then no-ops
			input?.blur();
		}
	}

	/** A src that resolves but fails to decode (deleted blob, expired URL). */
	let failed = $state(false);
	// A new src is a fresh attempt — clear a stale failure so a refreshed URL
	// (see Room's onImageExpired) can recover without remounting.
	$effect(() => {
		void src;
		failed = false;
	});
</script>

<div class="image" data-object-type="image">
	{#if editable}
		<input
			bind:this={input}
			bind:value={draft}
			class="caption"
			data-editable
			aria-label="Image description"
			placeholder="Describe this image"
			maxlength="1000"
			onblur={commit}
			onkeydown={onKeyDown}
			onpointerdown={(e) => {
				e.stopPropagation();
			}}
		/>
	{:else if object.payload.alt.trim() !== ''}
		<!-- Read-only, but still visible for reference. Empty alt shows nothing
		     rather than an empty bar. -->
		<p class="caption caption-static">{object.payload.alt}</p>
	{/if}

	<div class="picture">
		{#if src !== undefined && !failed}
			<!--
				`loading="lazy"` so a room full of images (up to 25, each a full-bytes
				download since there is no thumbnailing yet) does not fetch tiles that
				are panned off-screen; `decoding="async"` keeps decode off the main
				thread. No `width`/`height` attributes on purpose: the object's frame
				fixes the box and `object-fit: contain` handles the aspect, so there is
				no `height:auto` layout-shift for an intrinsic-size hint to prevent —
				they would add nothing here.
			-->
			<img
				class="img"
				{src}
				alt={label}
				draggable="false"
				loading="lazy"
				decoding="async"
				onerror={() => {
					failed = true;
					onexpired?.(object.payload.path);
				}}
			/>
		{:else}
			<!-- Undefined src is the normal first beat (the signed URL is still being
			     minted); failed is a blob that will not load. Either way, saying so
			     beats an empty box that reads as a broken object. -->
			<p class="placeholder">{failed ? `${label} could not load` : 'Loading image…'}</p>
		{/if}
	</div>
</div>

<style>
	.image {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		/* An image is content to look at, so it sits on a recessed ground; the
		   letterbox bars an off-aspect image leaves should read as frame, not as
		   part of the picture. Same choice ScreenshareObject makes. */
		background: var(--bg-level-1);
	}

	/* The caption strip, pinned above the picture and always visible. */
	.caption {
		flex: none;
		margin: 0;
		min-height: var(--control-height);
		padding: var(--space-1) var(--space-2);
		font-size: var(--text-sm);
		color: var(--text);
		background: var(--surface-2);
		border: none;
		border-bottom: 1px solid var(--border);
		border-radius: 0;
		/* One line, elided — a long description must not push the picture out. */
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.caption:focus-visible {
		outline: var(--ring-width) solid var(--focus-ring);
		outline-offset: calc(-1 * var(--ring-width));
	}
	.caption-static {
		display: flex;
		align-items: center;
	}

	.picture {
		flex: 1;
		min-height: 0;
		display: grid;
		place-items: center;
		overflow: hidden;
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
