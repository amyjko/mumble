<script lang="ts">
	import type { NoteCanvasObject } from '$lib/model/types';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import { renderMarkdown } from '$lib/model/markdown';

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

	/** Rendered markdown (UX-OBJ-2) overlays the raw textarea when not editing. */
	const rendered = $derived(renderMarkdown(object.payload.text));
	const showRendered = $derived(object.payload.text.trim() !== '' && (!focused || !editable));

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

<div class="note-body" data-editable>
	<textarea
		class="note"
		aria-label="Note text (markdown)"
		bind:value={draft}
		onfocus={() => (focused = true)}
		onblur={commitText}
		onkeydown={onKeyDown}
		readonly={!editable}
		placeholder="Write markdown…"
	></textarea>
	{#if showRendered}
		<!-- Read view. Pointer-transparent so a click lands on the textarea
		     beneath and enters editing; aria-hidden because the textarea already
		     exposes the note's text to assistive tech. -->
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMarkdown (model/markdown.ts) is safe by construction: it HTML-escapes all input before emitting only tags it generates, and validates link hrefs. XSS-rejection cases are covered in markdown.spec.ts. -->
		<div class="md" aria-hidden="true">{@html rendered}</div>
	{/if}
	{#if focused && editable}
		<!--
			Markdown support was discoverable only by reading the placeholder. The
			legend appears while editing, where it is useful and where it cannot
			cover the rendered view. aria-hidden: the textarea's own name already
			says "markdown", so this would just be noise read twice.
		-->
		<div class="legend" aria-hidden="true">
			<span><b>**bold**</b></span>
			<span><i>*italic*</i></span>
			<span># heading</span>
			<span>- bullet</span>
			<span>1. list</span>
		</div>
	{/if}
</div>

<style>
	.note-body {
		position: relative;
		width: 100%;
		height: 100%;
	}
	.note {
		position: absolute;
		inset: 0;
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
	.legend {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-2);
		background: var(--note-code-bg);
		color: var(--note-text);
		font-size: var(--text-xs);
		line-height: 1.3;
		pointer-events: none;
	}
	.md {
		position: absolute;
		inset: 0;
		pointer-events: none;
		overflow: auto;
		background: var(--note);
		padding: var(--space-2);
		font: var(--text-md) / var(--leading) var(--font-ui);
		color: var(--note-text);
		overflow-wrap: anywhere;
	}
	/* Rendered-markdown element styling (all from tokens). */
	.md :global(h1),
	.md :global(h2),
	.md :global(h3) {
		margin: 0 0 var(--space-1);
		line-height: 1.2;
	}
	.md :global(h1) {
		font-size: var(--text-lg);
	}
	.md :global(h2),
	.md :global(h3) {
		font-size: var(--text-md);
	}
	.md :global(p) {
		margin: 0 0 var(--space-1);
	}
	.md :global(ul),
	.md :global(ol) {
		margin: 0 0 var(--space-1);
		padding-left: var(--space-4);
	}
	.md :global(code) {
		font-family: var(--font-mono);
		font-size: 0.9em;
	}
	.md :global(pre) {
		margin: 0 0 var(--space-1);
		padding: var(--space-1) var(--space-2);
		background: var(--note-code-bg);
		border-radius: var(--radius-sm);
		overflow-x: auto;
	}
	.md :global(blockquote) {
		margin: 0 0 var(--space-1);
		padding-left: var(--space-2);
		border-left: 2px solid var(--note-quote-border);
		color: var(--note-text);
	}
	.md :global(a) {
		color: var(--accent);
	}
</style>
