<script lang="ts">
	import type { CanvasObject, Point, SolverShape, StoredIdentity, Transform } from '$lib/model/types';
	import type { RoomStore } from '$lib/store/room-store';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import type { Viewport } from './viewport.svelte';
	import { resolveDrag } from './geometry';
	import { canDelete, canEdit } from '$lib/model/permissions';
	import { shapeOfObject, participatesInCollision } from '$lib/store/memory-store.svelte';
	import ObjectContent from '$lib/objects/ObjectContent.svelte';
	import { displayMs, formatMs } from '$lib/model/timer';
	import { clipPathCss, nextClip } from '$lib/model/clip';
	import {
		resizeTransform,
		rotationForPointer,
		snapRotation,
		snapTo,
		minSizeFor,
		type ResizeHandle
	} from './resize';
	import { hint, SNAP_HINT } from './hint.svelte';
	import Button from '$lib/ui/Button.svelte';
	import { stopPointer } from '$lib/ui/events';
	import { RAISED_Z } from './layers';
	import TransformHandles from './TransformHandles.svelte';

	interface Props {
		object: CanvasObject;
		store: RoomStore;
		sync: SyncClient;
		viewport: Viewport;
		identity: StoredIdentity;
		/** Current occupancy for the solver, excluding this object. */
		obstacles: () => SolverShape[];
		/** Per-viewer fullscreen request (UX-CANVAS-4) — local, never synced. */
		onFullscreen: (id: string) => void;
	}

	let { object, store, sync, viewport, identity, obstacles, onFullscreen }: Props = $props();
	const actorId = $derived(identity.id);

	const editable = $derived(canEdit(object, actorId, false));
	const deletable = $derived(canDelete(object, actorId, false));
	/** Overlay (own or a peer's in-flight drag) wins over settled state. */
	const effective = $derived(sync.objectOverlays.get(object.id) ?? object.transform);
	const clipPath = $derived(clipPathCss(object.clip));

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
		if (object.type === 'drawing') return 'Drawing';
		const text = object.payload.text.trim();
		return text === '' ? 'Empty note' : `Note: ${text.slice(0, 40)}`;
	});

	/**
	 * What to call this object in delete affordances. The accessible name above
	 * is carefully type-aware; the delete button and its announcement were not,
	 * so a screen-reader user deleting a timer heard "Delete note" and then
	 * "Note deleted" (UX-A11Y-3).
	 */
	const noun = $derived(
		object.type === 'timer'
			? 'timer'
			: object.type === 'chat'
				? 'chat'
				: object.type === 'drawing'
					? 'drawing'
					: 'note'
	);

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

	/**
	 * Hover/focus raises the object above everything else in the world so its
	 * chrome is reachable (see layers.ts for why RAISED_Z beats AVATAR_Z).
	 * This has to be STATE rather than a `.frame:hover { z-index }` rule: the
	 * inline style:z-index below always wins over a stylesheet rule, so a CSS
	 * version would silently do nothing.
	 */
	let raised = $state(false);
	let pointerStart: Point = { x: 0, y: 0 };
	let objectStart: Point = { x: 0, y: 0 };
	let lastResolved: Point = { x: 0, y: 0 };
	let lastEphemeralAt = 0;

	function isEditableTarget(target: EventTarget | null): boolean {
		return target instanceof HTMLElement && target.closest('[data-editable]') !== null;
	}

	/** Move to a solver-constrained position: shared by pointer AND keyboard. */
	function moveTo(desired: Point, from: Point): Point {
		// An exempt object (a drawing) is not blocked BY anything either — being
		// invisible to others but still stopped by them would be an incoherent
		// half-rule.
		const moving: SolverShape = { ...shapeOfObject(object), x: from.x, y: from.y };
		const resolved = participatesInCollision(object) ? resolveDrag(moving, desired, obstacles()) : desired;
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

	function commitTransform(next: Transform): void {
		void sync.commit({ kind: 'move_object', id: object.id, transform: next }, object.id);
	}

	// Resize / rotate via handles. Both preview through the overlay and commit
	// move_object on release, so the solver validates the final transform (an
	// overlapping result reverts, UX-PERM-4). NOTE: resize/rotate math works on
	// world axes and ignores rotation — a prototype approximation; true
	// rotated-handle resize and rotated-shape collision are deferred.
	let handleKind = $state<ResizeHandle | 'rotate' | null>(null);
	const zeroT: Transform = { x: 0, y: 0, width: 0, height: 0, rotation: 0, z: 0 };
	let handleStart: Transform = zeroT;
	let handlePointer: Point = { x: 0, y: 0 };
	let handleLast: Transform = zeroT;

	function onHandleMove(event: PointerEvent): void {
		if (handleKind === null) return;
		const world = viewport.toWorld({ x: event.clientX, y: event.clientY });
		if (handleKind === 'rotate') {
			const center = { x: handleStart.x + handleStart.width / 2, y: handleStart.y + handleStart.height / 2 };
			handleLast = { ...handleStart, rotation: snapRotation(rotationForPointer(center, world), event.shiftKey) };
		} else {
			handleLast = resizeTransform(
				handleStart,
				handleKind,
				world.x - handlePointer.x,
				world.y - handlePointer.y,
				event.shiftKey,
				minSizeFor(object.type)
			);
		}
		sync.objectOverlays.set(object.id, handleLast);
	}

	function onHandleUp(): void {
		window.removeEventListener('pointermove', onHandleMove);
		hint.clear();
		if (handleKind === null) return;
		handleKind = null;
		commitTransform(handleLast);
	}

	// Window listeners rather than pointer capture on the handle: reliable under
	// both real and synthetic (test) pointer streams.
	function onHandleDown(kind: ResizeHandle | 'rotate', event: PointerEvent): void {
		event.stopPropagation();
		handleKind = kind;
		handleStart = { ...effective };
		handleLast = handleStart;
		handlePointer = viewport.toWorld({ x: event.clientX, y: event.clientY });
		hint.show(SNAP_HINT);
		window.addEventListener('pointermove', onHandleMove);
		window.addEventListener('pointerup', onHandleUp, { once: true });
	}

	function onPointerDown(event: PointerEvent): void {
		if (!editable || isEditableTarget(event.target)) return;
		event.stopPropagation();
		dragging = true;
		hint.show(SNAP_HINT);
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
			x: snapTo(objectStart.x + (world.x - pointerStart.x), event.shiftKey),
			y: snapTo(objectStart.y + (world.y - pointerStart.y), event.shiftKey)
		};
		lastResolved = moveTo(desired, lastResolved);
	}

	function onPointerUp(): void {
		hint.clear();
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
			sync.announce(`Deleted ${noun}`);
			event.preventDefault();
			return;
		}
		if (event.key === 'f' || event.key === 'F') {
			onFullscreen(object.id);
			event.preventDefault();
			return;
		}
		if ((event.key === 'c' || event.key === 'C') && editable) {
			cycleShape();
			event.preventDefault();
			return;
		}
		if (!editable) return;
		if (event.key === '[' || event.key === ']') {
			const delta = event.key === '[' ? -15 : 15;
			commitTransform({ ...object.transform, rotation: snapRotation(object.transform.rotation + delta, true) });
			event.preventDefault();
			return;
		}
		if (event.altKey && event.key.startsWith('Arrow')) {
			const g = 16;
			const t = object.transform;
			// Same per-type floor the pointer path uses, rather than a second
			// hard-coded 40 that could drift away from it.
			const min = minSizeFor(object.type);
			const grow =
				event.key === 'ArrowRight'
					? { width: t.width + g }
					: event.key === 'ArrowLeft'
						? { width: Math.max(min.width, t.width - g) }
						: event.key === 'ArrowDown'
							? { height: t.height + g }
							: { height: Math.max(min.height, t.height - g) };
			commitTransform({ ...t, ...grow });
			event.preventDefault();
			return;
		}
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
		sync.announce(`Deleted ${noun}`);
	}

	/** Escape inside the note returns focus to the frame (no trap — 2.1.2). */
	function exitToFrame(): void {
		frameEl?.focus();
	}

	/**
	 * Hiding is a LAYOUT property (UX-ROOM-3), captured per configuration
	 * alongside position and size — not a delete. The object keeps existing;
	 * its creator still sees it, ghosted, which is what makes this reversible.
	 */
	function toggleHidden(): void {
		void sync.commit({ kind: 'set_hidden', id: object.id, hidden: !object.hidden });
		sync.announce(object.hidden ? 'Object shown' : 'Object hidden from others');
	}

	function cycleShape(): void {
		const clip = nextClip(object.clip);
		void sync.commit({ kind: 'set_clip', id: object.id, clip });
		sync.announce(`Shape: ${clip.shape}`);
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
	real violation. Keyboard behavior per STYLE.md §6; verified by axe; logged
	in STYLE.md §10.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	bind:this={frameEl}
	class="frame"
	class:dragging
	class:locked={!editable}
	class:bare={object.type === 'drawing'}
	class:ghost={object.hidden}
	role="group"
	aria-label={label}
	tabindex="0"
	style:left="0"
	style:top="0"
	style:width="{effective.width}px"
	style:height="{effective.height}px"
	style:transform="translate({effective.x}px, {effective.y}px) rotate({effective.rotation}deg)"
	style:z-index={raised ? RAISED_Z : effective.z}
	onpointerenter={() => {
		raised = true;
	}}
	onpointerleave={() => {
		raised = false;
	}}
	onfocusin={() => {
		raised = true;
	}}
	onfocusout={() => {
		raised = false;
	}}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
	onkeydown={onKeyDown}
	onfocus={onFocus}
>
	<!--
		THE CLIP LIVES HERE, NOT ON .frame. clip-path clips painting AND hit
		testing for every descendant, so with it on the frame an ellipse or
		polygon silhouette erased all the chrome below — handles, rotate grip,
		fullscreen, delete, and the shape button itself, which left no pointer
		way back out of the shape. Chrome is now a SIBLING of the clipped layer,
		so it survives every clip.
	-->
	<div
		class="clip"
		style:border-radius={outerRadius}
		style:clip-path={clipPath ?? 'none'}
		style:padding="{object.border.width}px"
	>
		<!--
			The content carries the SAME clip-path string as the sticker layer, and
			that is what makes the border follow the silhouette (UX-OBJ-8). The
			shapes are percentage-based, and percentages resolve against each
			element's OWN box — .content sits inside the sticker's padding, so the
			identical string describes a correspondingly smaller shape. The visible
			sticker is then the ring between the two.

			Without it the sticker was clipped to the ellipse while the content
			stayed a rectangle, so the border showed only at the four cardinal
			extremes and disappeared at the diagonals, where the ellipse cut into
			the content instead of surrounding it. (rect/rounded/circle were always
			fine: border-radius already applies to both layers.)
		-->
		<div class="content" style:border-radius={innerRadius} style:clip-path={clipPath ?? 'none'}>
			<ObjectContent {object} {sync} {editable} {identity} onexit={exitToFrame} />
		</div>
	</div>
	<!--
		The ring is an inflated copy of the clipped silhouette rather than an
		outline: outline follows border-radius but NOT clip-path, so only a
		same-shape layer tracks an ellipse or polygon edge. Controls use a plain
		outline (app.css) precisely because they sit outside the clip.
	-->
	<div
		class="ring"
		aria-hidden="true"
		style:border-radius={outerRadius}
		style:clip-path={clipPath ?? 'none'}
	></div>
	{#if editable}
		<TransformHandles {onHandleDown} subject="object" />
		<span class="chrome visibility">
			<Button
				variant="chrome"
				shape="icon"
				pressed={object.hidden}
				label={object.hidden ? 'Show object (hidden from others)' : 'Hide object from others'}
				onpointerdown={stopPointer}
				onclick={toggleHidden}>{object.hidden ? '◌' : '●'}</Button
			>
		</span>
		{#if object.type !== 'drawing'}
			<!-- Drawings have no sticker border, so a clip edge on one is invisible
			     and the control is meaningless — hidden rather than ambiguous. -->
			<span class="chrome shape">
				<Button
					variant="chrome"
					shape="icon"
					label="Change shape (currently {object.clip.shape})"
					onpointerdown={stopPointer}
					onclick={cycleShape}>◇</Button
				>
			</span>
		{/if}
	{/if}
	<span class="chrome fullscreen">
		<Button
			variant="chrome"
			shape="icon"
			label="Fill screen with this object"
			onpointerdown={stopPointer}
			onclick={() => {
				onFullscreen(object.id);
			}}>⛶</Button
		>
	</span>
	{#if deletable}
		<span class="chrome delete">
			<Button
				variant="chrome"
				shape="icon"
				label="Delete {noun}"
				onpointerdown={stopPointer}
				onclick={onDelete}>×</Button
			>
		</span>
	{/if}
</div>

<style>
	.frame {
		position: absolute;
		box-sizing: border-box;
		cursor: grab;
		touch-action: none;
		user-select: none;
		outline: none; /* replaced by the .ring layer */
	}
	/* The sticker itself (UX-OBJ-8) — the layer the clip applies to. */
	.clip {
		position: absolute;
		inset: 0;
		box-sizing: border-box;
		background: var(--sticker);
		box-shadow: var(--shadow-1);
	}
	.frame.dragging {
		cursor: grabbing;
	}
	.frame.locked {
		cursor: default;
	}
	.frame.bare .clip {
		background: transparent;
		box-shadow: none;
	}
	/*
	 * Selection ring. Shown when the FRAME itself holds focus, or when focus is
	 * inside the object's own content (a note textarea, a chat input — both
	 * marked [data-editable]). Deliberately NOT :focus-within: with that,
	 * focusing a chrome button lit the object ring too and two things looked
	 * focused at once. Width is the global --ring-width, uniform with every
	 * control ring rather than the object's border thickness.
	 */
	.ring {
		position: absolute;
		inset: calc(-1 * var(--ring-width));
		background: var(--focus-ring);
		opacity: 0;
		pointer-events: none;
		z-index: -1;
	}
	/* The :has(...) is :global because [data-editable] lives inside the child
	   object components, so Svelte's scoper cannot see it from here and would
	   prune the rule as unused. */
	.frame:focus .ring,
	.frame:global(:has([data-editable] :focus)) .ring {
		opacity: 1;
	}
	.content {
		width: 100%;
		height: 100%;
		overflow: hidden;
	}
	/* Chrome badges are positioned wrappers; Button paints them. */
	.chrome {
		position: absolute;
		opacity: 0;
		transition: opacity 120ms;
	}
	.chrome.fullscreen {
		top: calc(-1 * var(--space-3));
		left: calc(-1 * var(--space-3));
	}
	.chrome.delete {
		top: calc(-1 * var(--space-3));
		right: calc(-1 * var(--space-3));
	}
	/*
	 * Fully BELOW the object, not overlapping it. The corner badges overhang
	 * into corners an ellipse never reaches, but bottom-centre sits right on
	 * the silhouette of a round object — placed like the others it covered the
	 * sticker edge and the content beneath it.
	 */
	.chrome.visibility {
		top: 100%;
		margin-top: var(--space-1);
		left: 50%;
		translate: -50% 0;
	}
	/*
	 * A hidden object is still fully interactive for its creator — this is a
	 * reversible layout state, not a disabled one — so the ghosting is purely
	 * visual and never blocks pointer events.
	 */
	.frame.ghost .clip {
		opacity: 0.4;
	}
	.frame.ghost .clip::after {
		content: '';
		position: absolute;
		inset: 0;
		border: 2px dashed var(--border-strong);
		border-radius: inherit;
		pointer-events: none;
	}
	.chrome.shape {
		bottom: calc(-1 * var(--space-3));
		left: calc(-1 * var(--space-3));
	}
	/*
	 * Reveal keeps the BROADER :focus-within condition on purpose — tabbing to
	 * a handle must not hide the handle you just reached. Only the selection
	 * ring above uses the narrower rule.
	 */
	.frame:hover :global(.resize),
	.frame:focus-within :global(.resize),
	.frame:hover :global(.rotate),
	.frame:focus-within :global(.rotate),
	.frame:hover .chrome,
	.frame:focus-within .chrome {
		opacity: 1;
	}

</style>
