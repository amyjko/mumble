<script lang="ts">
	import type { CanvasObject, Permission, Point, SolverShape, StoredIdentity, Transform } from '$lib/model/types';
	import { createDeferredCommit } from './deferred.svelte';
	import type { RoomStore } from '$lib/store/room-store';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import type { Viewport } from './viewport.svelte';
	import { resolveDrag } from './geometry';
	import { PERMISSION_EMOJI, PERMISSION_LABEL, canDelete, canEdit } from '$lib/model/permissions';
	import Emoji from '$lib/ui/Emoji.svelte';
	import { shapeOfObject, participatesInCollision } from '$lib/store/memory-store.svelte';
	import ObjectContent from '$lib/objects/ObjectContent.svelte';
	import { displayMs, formatMs } from '$lib/model/timer';
	import { clipPathCss, nextClip } from '$lib/model/clip';
	import { minSizeFor } from './resize';
	import {
		arrowDelta,
		createDragGesture,
		createHandleGesture,
		isReshapeKey,
		resizeByKey,
		rotateByKey
	} from './gesture.svelte';
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
		/** Host role in this room (UX-PERM-1's `host` value finally resolves). */
		isHost?: boolean | undefined;
		/** Current occupancy for the solver, excluding this object. */
		obstacles: () => SolverShape[];
		/** Per-viewer fullscreen request (UX-CANVAS-4) — local, never synced. */
		onFullscreen: (id: string) => void;
		/** Live screen shares by owner id (UX-OBJ-6); only a screenshare reads it. */
		screenStreams?: ReadonlyMap<string, MediaStream> | undefined;
		/** Display names by participant id, for a share's accessible name. */
		names?: ReadonlyMap<string, string> | undefined;
	}

	let {
		object,
		store,
		sync,
		viewport,
		identity,
		isHost = false,
		obstacles,
		onFullscreen,
		screenStreams,
		names
	}: Props = $props();
	const actorId = $derived(identity.id);

	const editable = $derived(canEdit(object, actorId, isHost));
	const deletable = $derived(canDelete(object, actorId, isHost));
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
		if (object.type === 'screenshare') {
			const owner = store.state.participants[object.payload.owner_id]?.name;
			return owner === undefined ? 'A shared screen' : `${owner}’s shared screen`;
		}
		// Note is what remains. Naming it rather than falling through: this chain
		// read `object.payload.text` for "everything else", which silently became
		// a type error the moment a fifth object type existed.
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
					: object.type === 'screenshare'
						? 'screen share'
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

	/**
	 * Hover/focus raises the object above everything else in the world so its
	 * chrome is reachable (see layers.ts for why RAISED_Z beats AVATAR_Z).
	 * This has to be STATE rather than a `.frame:hover { z-index }` rule: the
	 * inline style:z-index below always wins over a stylesheet rule, so a CSS
	 * version would silently do nothing.
	 */
	let raised = $state(false);

	function isEditableTarget(target: EventTarget | null): boolean {
		return target instanceof HTMLElement && target.closest('[data-editable]') !== null;
	}

	/**
	 * Solver-constrained position, shared by pointer AND keyboard.
	 *
	 * An exempt object (a drawing) is not blocked BY anything either — being
	 * invisible to others but still stopped by them would be an incoherent
	 * half-rule.
	 */
	function resolvePosition(desired: Point, from: Point): Point {
		const moving: SolverShape = { ...shapeOfObject(object), x: from.x, y: from.y };
		return participatesInCollision(object) ? resolveDrag(moving, desired, obstacles()) : desired;
	}

	/** Preview + broadcast, for the keyboard path (the drag gesture does its own). */
	function showAt(position: Point): void {
		sync.objectOverlays.set(object.id, { ...object.transform, x: position.x, y: position.y });
	}

	function commitMove(position: Point): void {
		const final: Transform = { ...object.transform, x: position.x, y: position.y };
		void sync.commit({ kind: 'move_object', id: object.id, transform: final }, object.id);
	}

	function commitTransform(next: Transform): void {
		void sync.commit({ kind: 'move_object', id: object.id, transform: next }, object.id);
	}

	// Resize / rotate preview through the overlay and commit move_object on
	// release, so the solver validates the final transform (an overlapping
	// result reverts, UX-PERM-4). The math works on world axes and ignores
	// rotation — a ratified approximation, see resize.ts.

	const handles = createHandleGesture({
		viewport: () => viewport,
		start: () => ({ ...effective }),
		min: () => minSizeFor(object.type),
		preview: (next) => {
			sync.objectOverlays.set(object.id, next);
		},
		commit: (next) => {
			commitTransform(next);
		}
	});

	const drag = createDragGesture({
		viewport: () => viewport,
		enabled: () => editable,
		origin: () => ({ x: effective.x, y: effective.y }),
		resolve: resolvePosition,
		preview: showAt,
		broadcast: (at) => {
			store.sendEphemeral({
				kind: 'drag_object',
				id: object.id,
				transform: { ...object.transform, x: at.x, y: at.y }
			});
		},
		commit: commitMove
	});

	/**
	 * Keyboard movement (UX-A11Y-2): arrows move through the SAME solver as
	 * drag — the overlap rule and permission gate apply identically. Commits
	 * are debounced so a held key is one mutation, not fifty.
	 */
	let keyboardPosition: Point | null = null;
	const keyboardCommit = createDeferredCommit();

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
		if (isReshapeKey(event) && editable) {
			cycleShape();
			event.preventDefault();
			return;
		}
		if (!editable) return;
		const rotation = rotateByKey(object.transform.rotation, event);
		if (rotation !== null) {
			commitTransform({ ...object.transform, rotation });
			event.preventDefault();
			return;
		}
		if (event.altKey) {
			// The same per-type floor the pointer path uses, rather than a second
			// hard-coded number that could drift away from it.
			const size = resizeByKey(object.transform, event, minSizeFor(object.type));
			if (size === null) return;
			commitTransform({ ...object.transform, ...size });
			event.preventDefault();
			return;
		}
		const move = arrowDelta(event);
		if (move === null) return;
		event.preventDefault();
		const from = keyboardPosition ?? { x: effective.x, y: effective.y };
		keyboardPosition = resolvePosition({ x: from.x + move.x, y: from.y + move.y }, from);
		showAt(keyboardPosition);
		keyboardCommit.schedule(() => {
			if (keyboardPosition !== null) commitMove(keyboardPosition);
			keyboardPosition = null;
		});
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
	/**
	 * Who besides the creator may edit this (UX-PERM-1). Cycles all -> host ->
	 * none, the enum's own order. Creator-only, because with 'all' anyone can
	 * edit the object and letting them re-lock it would let a passer-by take it.
	 */
	const isCreator = $derived(object.creator_id === actorId);

	function cyclePermission(): void {
		const next: Permission =
			object.permission === 'all' ? 'host' : object.permission === 'host' ? 'none' : 'all';
		void sync.commit({ kind: 'set_permission', id: object.id, permission: next });
		sync.announce(PERMISSION_LABEL[next]);
	}

	/**
	 * Cycle the sticker border (UX-OBJ-8). Not decorative: the width IS the
	 * overlap tolerance (UX-OBJ-12), so a thinner border means the object's
	 * content grows and the store re-checks the placement — narrowing can be
	 * refused if it would push content into a neighbour.
	 */
	const BORDER_STEPS = [0, 6, 10, 18, 28];
	function cycleBorder(): void {
		const current = object.border.width;
		const at = BORDER_STEPS.findIndex((w) => w >= current);
		const next = BORDER_STEPS[(at + 1) % BORDER_STEPS.length] ?? BORDER_STEPS[0] ?? 0;
		void sync.commit({ kind: 'set_border', id: object.id, width: next });
		sync.announce(`Border ${String(next)} pixels`);
	}

	function toggleHidden(): void {
		void sync.commit({ kind: 'set_hidden', id: object.id, hidden: !object.hidden });
		sync.announce(object.hidden ? 'Object shown' : 'Object hidden from others');
	}

	/**
	 * Depth controls (UX-OBJ-11): drawings may sit above OR below content.
	 *
	 * z existed in the schema and was only ever assigned at creation, so
	 * stacking was strictly the order things were made in — a drawing made
	 * before a note could never be moved on top of it, and one made after could
	 * never be tucked behind. Two buttons is the whole feature.
	 */
	function sendToBack(): void {
		const lowest = Math.min(...Object.values(store.state.objects).map((o) => o.transform.z));
		commitTransform({ ...effective, z: lowest - 1 });
		sync.announce(`${label} sent to back`);
	}

	function bringToFront(): void {
		const highest = Math.max(...Object.values(store.state.objects).map((o) => o.transform.z));
		commitTransform({ ...effective, z: highest + 1 });
		sync.announce(`${label} brought to front`);
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
	class:dragging={drag.dragging}
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
	onpointerdown={(event) => {
		// A press inside the note's textarea is text editing, not a drag.
		if (isEditableTarget(event.target)) return;
		drag.onPointerDown(event);
	}}
	onpointermove={drag.onPointerMove}
	onpointerup={drag.onPointerUp}
	onpointercancel={drag.onPointerUp}
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
			<ObjectContent
				{object}
				{sync}
				{editable}
				{identity}
				{screenStreams}
				{names}
				onexit={exitToFrame}
			/>
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
		<TransformHandles onHandleDown={handles.onHandleDown} subject="object" />
		<!--
			One ROW below the frame, not four hand-placed offsets from centre.
			Each control used to compute its own translate() as a multiple of the
			control height; adding a fifth and sixth meant recomputing all of them,
			and any mistake silently overlaps two buttons so aiming at one hits the
			other. A flex row cannot overlap.
		-->
		<div class="chrome chrome-row">
		{#if isCreator}
			<span class="group">
				<Button
					variant="chrome"
					shape="icon"
					label="Send {label} behind other content"
					onpointerdown={stopPointer}
					onclick={sendToBack}>⤓</Button
				>
				<Button
					variant="chrome"
					shape="icon"
					label="Bring {label} in front of other content"
					onpointerdown={stopPointer}
					onclick={bringToFront}>⤒</Button
				>
			</span>
			<span class="group">
				<Button
					variant="chrome"
					shape="icon"
					label="Change who can edit ({PERMISSION_LABEL[object.permission]})"
					onpointerdown={stopPointer}
					onclick={cyclePermission}
					><Emoji glyph={PERMISSION_EMOJI[object.permission]} /></Button
				>
			</span>
		{/if}
		<span class="group">
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
			<span class="group">
				<Button
					variant="chrome"
					shape="icon"
					label="Change sticker border (currently {object.border.width} pixels)"
					onpointerdown={stopPointer}
					onclick={cycleBorder}>▣</Button
				>
			</span>
		{/if}
		{#if object.type !== 'drawing'}
			<!-- Drawings have no sticker border, so a clip edge on one is invisible
			     and the control is meaningless — hidden rather than ambiguous. -->
			<span class="group">
				<Button
					variant="chrome"
					shape="icon"
					label="Change shape (currently {object.clip.shape})"
					onpointerdown={stopPointer}
					onclick={cycleShape}>◇</Button
				>
			</span>
		{/if}
		</div>
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
		/* `move`, not `grab`: the canvas beneath uses grab for panning, and
		   identical cursors gave no cue which gesture a press would start. */
		cursor: move;
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
	/*
	 * BELOW the object, never in a corner. All four corners are spoken for
	 * (fullscreen, delete, and the resize grips), and chrome at bottom-right
	 * swallowed the `se` handle's clicks. Same lesson as the visibility badge
	 * covering a round object's silhouette: the frame's edges are crowded, so
	 * new chrome goes outside it.
	 */
	.chrome-row {
		top: 100%;
		/* Padding, not margin: it bridges the gap so travelling from the frame
		   to these controls never leaves the hover region. */
		padding-top: var(--space-1);
		left: 50%;
		translate: -50% 0;
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}
	.chrome-row .group {
		display: flex;
		gap: var(--space-1);
	}
	/* Beside the shape control, both outside the frame's crowded corners. */
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
