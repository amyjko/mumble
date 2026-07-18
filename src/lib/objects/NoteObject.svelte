<script lang="ts">
	import type { NoteCanvasObject } from '$lib/model/types';
	import type { SyncClient } from '$lib/store/sync-client.svelte';

	interface Props {
		object: NoteCanvasObject;
		sync: SyncClient;
		editable: boolean;
		/** Escape hands focus back to the frame (no keyboard trap — 2.1.2). */
		onexit: () => void;
	}

	let { object, sync, editable, onexit }: Props = $props();

	/**
	 * Local draft while typing; remote updates apply only when not focused, so
	 * a peer's edit never yanks the caret. (Real concurrent editing is CRDT
	 * territory — AR-SYNC-4, deliberately deferred.)
	 */
	// Deliberate initial-value capture: draft is the local editing buffer; the
	// $effect below syncs remote edits in while the textarea is unfocused.
	// svelte-ignore state_referenced_locally
	let draft = $state(object.payload.text);
	let focused = $state(false);

	$effect(() => {
		if (!focused) draft = object.payload.text;
	});

	function commitText(): void {
		focused = false;
		if (draft === object.payload.text) return;
		void sync.commit({ kind: 'edit_note', id: object.id, payload: { text: draft } });
	}

	function onKeyDown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			commitText();
			onexit();
		}
	}
</script>

<textarea
	data-editable
	class="note"
	aria-label="Note text"
	bind:value={draft}
	onfocus={() => (focused = true)}
	onblur={commitText}
	onkeydown={onKeyDown}
	readonly={!editable}
	placeholder="Write something…"
></textarea>

<style>
	.note {
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		border: none;
		resize: none;
		outline: none;
		background: var(--note);
		padding: var(--space-2);
		font: var(--text-md) / var(--leading) var(--font-ui);
		color: var(--note-text);
	}
	.note[readonly] {
		cursor: default;
	}
</style>
