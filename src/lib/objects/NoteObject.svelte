<script lang="ts">
	import type { NoteCanvasObject } from '$lib/model/types';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import { renderMarkdown } from '$lib/model/markdown';
	import { untrack } from 'svelte';
	import * as Y from 'yjs';
	import { applyEncodedUpdate, encodeUpdateSince, noteText, textType } from '$lib/model/ydoc';

	interface Props {
		object: NoteCanvasObject;
		sync: SyncClient;
		editable: boolean;
		/** Escape hands focus back to the frame (no keyboard trap — 2.1.2). */
		onexit: () => void;
	}

	let { object, sync, editable, onexit }: Props = $props();

	/**
	 * Live collaborative editing (UX-OBJ-2 / AR-SYNC-4).
	 *
	 * The old model kept a local draft and applied remote text only while
	 * UNFOCUSED, which is precisely what made concurrent editing impossible:
	 * whoever blurred last overwrote the other's work wholesale. Now a local
	 * Y.Doc mirrors the note, local keystrokes become CRDT updates, and remote
	 * updates apply *while you type* — with the caret carried across them.
	 */
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let focused = $state(false);
	/**
	 * True while an IME composition is in flight. Applying a remote update
	 * mid-composition destroys the pending characters, so remote text is held
	 * back until the composition commits — the failure mode that makes
	 * hand-rolled editor bindings unusable in Japanese, Chinese, and Korean.
	 */
	let composing = $state(false);

	const doc = new Y.Doc();
	let text = $state('');

	/** What the DOM currently shows, so we can diff the next input against it. */
	let shown = '';

	function syncFromDoc(): void {
		text = noteText(doc);
	}

	/**
	 * Pull the store's state into the local document. Merging (not assigning)
	 * is what makes this safe to run at any moment, including mid-keystroke:
	 * our own un-broadcast characters survive, and the operation is idempotent,
	 * so a snapshot we have already seen changes nothing.
	 */
	$effect(() => {
		const encoded = object.payload.doc;
		untrack(() => {
			// Capture the caret BEFORE merging. A relative position is only
			// meaningful against the document it was taken from: resolve the old
			// index after the merge and it points wherever the peer's insertion
			// happened to push that offset — typing "!" at the end of "END"
			// after someone prepends "START " lands it as "STA!RT END".
			const anchors = captureCaret();
			if (encoded !== '') applyEncodedUpdate(doc, encoded);
			syncFromDoc();
			if (!composing) render(anchors);
		});
	});

	interface CaretAnchors {
		start: Y.RelativePosition;
		end: Y.RelativePosition;
	}

	function captureCaret(): CaretAnchors | null {
		const el = textarea;
		if (el === null || document.activeElement !== el) return null;
		const type = textType(doc);
		return {
			start: Y.createRelativePositionFromTypeIndex(type, Math.min(el.selectionStart, type.length)),
			end: Y.createRelativePositionFromTypeIndex(type, Math.min(el.selectionEnd, type.length))
		};
	}

	/**
	 * Write the document's text into the textarea, preserving the caret ACROSS
	 * concurrent edits.
	 *
	 * The caret is captured as a Yjs relative position before the value
	 * changes and resolved back to an index afterwards, so a peer inserting
	 * text earlier in the note pushes your caret along with your own
	 * characters rather than stranding it at a stale offset. A plain index
	 * would drift by exactly the length of their insertion.
	 */
	function render(anchors: CaretAnchors | null): void {
		const el = textarea;
		if (el === null) return;
		if (el.value === text) {
			shown = text;
			return;
		}
		el.value = text;
		shown = text;
		if (anchors === null) return;
		// Resolve the pre-merge anchors against the POST-merge document: a peer's
		// insertion ahead of the caret moves the caret with it, which is exactly
		// what a plain index cannot express.
		const from = Y.createAbsolutePositionFromRelativePosition(anchors.start, doc);
		const to = Y.createAbsolutePositionFromRelativePosition(anchors.end, doc);
		el.setSelectionRange(from?.index ?? text.length, to?.index ?? text.length);
	}

	/**
	 * Turn a textarea value change into a minimal CRDT edit.
	 *
	 * Diffing by common prefix/suffix keeps an edit local to where it happened,
	 * which is what lets two people work in different paragraphs without
	 * touching each other's text. Replacing the whole string instead would
	 * make every keystroke conflict with every other.
	 */
	function onInput(): void {
		const el = textarea;
		if (el === null || !editable) return;
		const next = el.value;
		const previous = shown;
		if (next === previous) return;

		let prefix = 0;
		const max = Math.min(previous.length, next.length);
		while (prefix < max && previous[prefix] === next[prefix]) prefix++;
		let suffix = 0;
		while (
			suffix < max - prefix &&
			previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
		) {
			suffix++;
		}
		const removed = previous.length - prefix - suffix;
		const inserted = next.slice(prefix, next.length - suffix);

		const before = Y.encodeStateVector(doc);
		doc.transact(() => {
			const type = textType(doc);
			if (removed > 0) type.delete(prefix, removed);
			if (inserted !== '') type.insert(prefix, inserted);
		});
		shown = next;
		syncFromDoc();

		// Send only what changed since the store last saw this document.
		const update = encodeUpdateSince(doc, before);
		void sync.commit({ kind: 'edit_note', id: object.id, update });
	}

	/** Rendered markdown (UX-OBJ-2) overlays the raw textarea when not editing. */
	const rendered = $derived(renderMarkdown(text));
	const showRendered = $derived(text.trim() !== '' && (!focused || !editable));

	function onKeyDown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			focused = false;
			onexit();
		}
	}
</script>

<div class="note-body" data-editable>
	<!--
		No bind:value. The value is written by render(), which carries the caret
		across concurrent edits; a two-way binding would fight it and reset the
		selection every time a peer typed a character.
	-->
	<textarea
		bind:this={textarea}
		class="note"
		aria-label="Note text (markdown)"
		oninput={onInput}
		onfocus={() => (focused = true)}
		onblur={() => (focused = false)}
		oncompositionstart={() => (composing = true)}
		oncompositionend={() => {
			composing = false;
			onInput();
		}}
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
