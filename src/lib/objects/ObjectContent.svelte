<script lang="ts">
	import type { CanvasObject, StoredIdentity } from '$lib/model/types';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import NoteObject from './NoteObject.svelte';
	import TimerObject from './TimerObject.svelte';
	import ChatObject from './ChatObject.svelte';
	import DrawingObject from './DrawingObject.svelte';
	import ScreenshareObject from './ScreenshareObject.svelte';
	import ImageObject from './ImageObject.svelte';

	/**
	 * Renders an object's inner content by type (AR-CANVAS-3 dispatch). Shared
	 * by ObjectFrame and the fullscreen overlay (UX-CANVAS-4) so both stay in
	 * sync as object types grow.
	 */
	interface Props {
		object: CanvasObject;
		sync: SyncClient;
		editable: boolean;
		identity: StoredIdentity;
		/** Escape hands focus back to the caller's context (no keyboard trap). */
		onexit: () => void;
		/**
		 * Live screen shares, keyed by the OWNER's participant id (UX-OBJ-6).
		 *
		 * Passed down rather than read from a store: a MediaStream is not room
		 * state. Optional so every existing caller keeps working — an object that
		 * is not a screenshare never looks at it.
		 */
		screenStreams?: ReadonlyMap<string, MediaStream> | undefined;
		/** Display names by participant id, for a share's accessible name. */
		names?: ReadonlyMap<string, string> | undefined;
		/**
		 * Signed URLs for image objects, keyed by their Storage path (UX-OBJ-5).
		 *
		 * Passed down for the same reason as `screenStreams`: a signed URL is
		 * per-viewer and expiring, not room state. Optional so non-image callers
		 * are unaffected.
		 */
		imageUrls?: ReadonlyMap<string, string> | undefined;
		/** An image tile's URL failed to load; ask Room to re-mint it (UX-OBJ-5). */
		onImageExpired?: ((path: string) => void) | undefined;
	}

	let {
		object,
		sync,
		editable,
		identity,
		onexit,
		screenStreams,
		names,
		imageUrls,
		onImageExpired
	}: Props = $props();
</script>

{#if object.type === 'note'}
	<NoteObject {object} {sync} {editable} {onexit} />
{:else if object.type === 'timer'}
	<TimerObject {object} {sync} {editable} />
{:else if object.type === 'chat'}
	<ChatObject {object} {sync} {identity} {onexit} />
{:else if object.type === 'drawing'}
	<DrawingObject {object} />
{:else if object.type === 'screenshare'}
	<ScreenshareObject
		{object}
		stream={screenStreams?.get(object.payload.owner_id)}
		ownerName={names?.get(object.payload.owner_id)}
		isSelf={object.payload.owner_id === identity.id}
	/>
{:else if object.type === 'image'}
	<ImageObject
		{object}
		{sync}
		{editable}
		src={imageUrls?.get(object.payload.path)}
		onexpired={onImageExpired}
	/>
{/if}
