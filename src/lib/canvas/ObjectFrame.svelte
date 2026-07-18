<script lang="ts">
	import type { CanvasObject, Point, SolverShape, StoredIdentity, Transform } from '$lib/model/types';
	import type { RoomStore } from '$lib/store/room-store';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import type { Viewport } from './viewport.svelte';
	import { resolveMove } from './geometry';
	import { canDelete, canEdit } from '$lib/model/permissions';
	import { shapeOfObject } from '$lib/store/memory-store.svelte';
	import NoteObject from '$lib/objects/NoteObject.svelte';
	import TimerObject from '$lib/objects/TimerObject.svelte';
	import ChatObject from '$lib/objects/ChatObject.svelte';
	import { displayMs, formatMs } from '$lib/model/timer';

	interface Props {
		object: CanvasObject;
		store: RoomStore;
		sync: SyncClient;
		viewport: Viewport;
		identity: StoredIdentity;
		/** Current occupancy for the solver, excluding this object. */
		obstacles: () => SolverShape[];
	}

	let { object, store, sync, viewport, identity, obstacles }: Props = $props();
	const actorId = $derived(identity.id);

	const editable = $derived(canEdit(object, actorId, false));
	const deletable = $derived(canDelete(object, actorId, false));
	/** Overlay (own or a peer's in-flight drag) wins over settled state. */
	const effective = $derived(sync.objectOverlays.get(object.id) ?? object.transform);

	/** Real accessible name (UX-A11Y-3): content, not chrome. Type-aware. */
	const label = $derived.by(() => {
		if (object.type === 'timer') {
			const kind = object.payload.mode === 'countdown' ? 'Countdown' : 'Count-up';
			return `${kind} timer, ${formatMs(displayMs(object.payload, Date.now()))}`;
		}
		if (object.type === 'chat') {
			const n = object.payload.messages.length;
			return `Chat, ${String(n)} message${n === 1 ? '' : 's'}`;
		}
		const text = object.payload.text.trim();
		return text === '' ? 'Empty note' : `Note: ${text.slice(0, 40)}`;
	});

	const outerRadius = $derived(
		object.clip.shape === 'circle'
			? '50%'
			: object.clip.shape === 'rounded'
				? `${String(object.clip.radius + object.border.width)}px`
				: '0'
	);
	const innerRadius = $derived(
		object.clip.shape === 'circle'
			? '50%'
			: object.clip.shape === 'rounded'
				? `${String(object.clip.radius)}px`
				: '0'
	);

	let frameEl = $state<HTMLElement | null>(null);
	let dragging = $state(false);
	let pointerStart: Point = { x: 0, y: 0 };
	let objectStart: Point = { x: 0, y: 0 };
	let lastResolved: Point = { x: 0, y: 0 };
	let lastEphemeralAt = 0;

	function isEditableTarget(target: EventTarget | null): boolean {
		return target instanceof HTMLElement && target.closest('[data-editable]') !== null;
	}

	/** Move to a solver-constrained position: shared by pointer AND keyboard. */
	function moveTo(desired: Point, from: Point): Point {
		const moving: SolverShape = { ...shapeOfObject(object), x: from.x, y: from.y };
		const resolved = resolveMove(moving, desired, obstacles());
		const next: Transform = { ...object.transform, x: resolved.x, y: resolved.y };
		sync.objectOverlays.set(object.id, next);
		const now = performance.now();
		if (now - lastEphemeralAt > 50) {
			lastEphemeralAt = now;
			store.sendEphemeral({ kind: 'drag_object', id: object.id, transform: next });
		}
		return resolved;
	}

	function commitMove(position: Point): void {
		const final: Transform = { ...object.transform, x: position.x, y: position.y };
		void sync.commit({ kind: 'move_object', id: object.id, transform: final }, object.id);
	}

	function onPointerDown(event: PointerEvent): void {
		if (!editable || isEditableTarget(event.target)) return;
		event.stopPropagation();
		dragging = true;
		pointerStart = viewport.toWorld({ x: event.clientX, y: event.clientY });
		objectStart = { x: effective.x, y: effective.y };
		lastResolved = objectStart;
		if (event.currentTarget instanceof HTMLElement) {
			event.currentTarget.setPointerCapture(event.pointerId);
		}
	}

	function onPointerMove(event: PointerEvent): void {
		if (!dragging) return;
		const world = viewport.toWorld({ x: event.clientX, y: event.clientY });
		const desired = {
			x: objectStart.x + (world.x - pointerStart.x),
			y: objectStart.y + (world.y - pointerStart.y)
		};
		lastResolved = moveTo(desired, lastResolved);
	}

	function onPointerUp(): void {
		if (!dragging) return;
		dragging = false;
		commitMove(lastResolved);
	}

	/**
	 * Keyboard movement (UX-A11Y-2): arrows move through the SAME solver as
	 * drag — the overlap rule and permission gate apply identically. Commits
	 * are debounced so a held key is one mutation, not fifty.
	 */
	let keyboardPosition: Point | null = null;
	let keyboardCommitTimer: ReturnType<typeof setTimeout> | null = null;

	function onKeyDown(event: KeyboardEvent): void {
		if (event.target !== event.currentTarget) return;
		if (event.key === 'Enter') {
			// Jump into the object's first control — the note textarea, or the
			// timer's primary button — so editing is reachable without a pointer.
			const control = frameEl?.querySelector('textarea, button');
			if (control instanceof HTMLElement) control.focus();
			event.preventDefault();
			return;
		}
		if ((event.key === 'Delete' || event.key === 'Backspace') && deletable) {
			void sync.commit({ kind: 'delete_object', id: object.id });
			sync.announce('Note deleted');
			event.preventDefault();
			return;
		}
		if (!editable) return;
		const step = event.shiftKey ? 1 : 16;
		let dx = 0;
		let dy = 0;
		switch (event.key) {
			case 'ArrowLeft':
				dx = -step;
				break;
			case 'ArrowRight':
				dx = step;
				break;
			case 'ArrowUp':
				dy = -step;
				break;
			case 'ArrowDown':
				dy = step;
				break;
			default:
				return;
		}
		event.preventDefault();
		const from = keyboardPosition ?? { x: effective.x, y: effective.y };
		keyboardPosition = moveTo({ x: from.x + dx, y: from.y + dy }, from);
		if (keyboardCommitTimer !== null) clearTimeout(keyboardCommitTimer);
		keyboardCommitTimer = setTimeout(() => {
			if (keyboardPosition !== null) commitMove(keyboardPosition);
			keyboardPosition = null;
		}, 250);
	}

	function onDelete(): void {
		void sync.commit({ kind: 'delete_object', id: object.id });
		sync.announce('Note deleted');
	}

	/** Escape inside the note returns focus to the frame (no trap — 2.1.2). */
	function exitToFrame(): void {
		frameEl?.focus();
	}

	/** Tabbing here reveals the object if it's off-screen (UX-A11Y). */
	function onFocus(): void {
		viewport.ensureVisible({
			x: effective.x,
			y: effective.y,
			width: effective.width,
			height: effective.height
		});
	}
</script>

<!--
	ARIA has no role for a movable canvas object. role="group" + tabindex is
	the least-wrong mapping: a widget role like button would nest interactive
	controls (the textarea, delete) inside an interactive element, which is a
	real violation. Keyboard behavior per STYLE.md §5; verified by axe; logged
	in STYLE.md §9.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	bind:this={frameEl}
	class="frame"
	class:dragging
	class:locked={!editable}
	role="group"
	aria-label={label}
	tabindex="0"
	style:left="0"
	style:top="0"
	style:width="{effective.width}px"
	style:height="{effective.height}px"
	style:transform="translate({effective.x}px, {effective.y}px) rotate({effective.rotation}deg)"
	style:z-index={effective.z}
	style:border-radius={outerRadius}
	style:padding="{object.border.width}px"
	style:--ring-width="{object.border.width}px"
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
	onkeydown={onKeyDown}
	onfocus={onFocus}
>
	<div class="content" style:border-radius={innerRadius}>
		<!-- Dispatch on the discriminated union (AR-CANVAS-3). -->
		{#if object.type === 'note'}
			<NoteObject {object} {sync} {editable} onexit={exitToFrame} />
		{:else if object.type === 'timer'}
			<TimerObject {object} {sync} {editable} />
		{:else if object.type === 'chat'}
			<ChatObject {object} {sync} {identity} onexit={exitToFrame} />
		{/if}
	</div>
	{#if deletable}
		<button
			class="delete"
			aria-label="Delete note"
			onpointerdown={(e) => {
				e.stopPropagation();
			}}
			onclick={onDelete}>×</button
		>
	{/if}
</div>

<style>
	.frame {
		position: absolute;
		box-sizing: border-box;
		background: var(--sticker); /* the sticker (UX-OBJ-8): cutout edge following the clip */
		box-shadow: var(--shadow-1);
		cursor: grab;
		touch-action: none;
		user-select: none;
		outline: none; /* replaced by the selection ring below */
	}
	/* Selection ring (STYLE.md §7.4): always-on when focused — click OR
	   keyboard — and persists while editing. Thickness = this object's own
	   sticker border; box-shadow follows the clip radius with no layout shift. */
	.frame:focus-within {
		box-shadow:
			0 0 0 var(--ring-width) var(--focus-ring),
			var(--shadow-1);
	}
	.frame.dragging {
		cursor: grabbing;
	}
	.frame.locked {
		cursor: default;
	}
	.content {
		width: 100%;
		height: 100%;
		overflow: hidden;
	}
	.delete {
		position: absolute;
		top: calc(-1 * var(--space-3));
		right: calc(-1 * var(--space-3));
		width: var(--target-min);
		height: var(--target-min);
		border-radius: var(--radius-full);
		border: none;
		background: var(--text);
		color: var(--surface);
		font-size: var(--text-md);
		line-height: 1;
		cursor: pointer;
		opacity: 0;
		transition: opacity 120ms;
	}
	.frame:hover .delete,
	.frame:focus-within .delete {
		opacity: 1;
	}
</style>
