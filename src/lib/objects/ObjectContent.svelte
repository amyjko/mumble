<script lang="ts">
	import type { CanvasObject, StoredIdentity } from '$lib/model/types';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import NoteObject from './NoteObject.svelte';
	import TimerObject from './TimerObject.svelte';
	import ChatObject from './ChatObject.svelte';
	import DrawingObject from './DrawingObject.svelte';

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
	}

	let { object, sync, editable, identity, onexit }: Props = $props();
</script>

{#if object.type === 'note'}
	<NoteObject {object} {sync} {editable} {onexit} />
{:else if object.type === 'timer'}
	<TimerObject {object} {sync} {editable} />
{:else if object.type === 'chat'}
	<ChatObject {object} {sync} {identity} {onexit} />
{:else if object.type === 'drawing'}
	<DrawingObject {object} />
{/if}
