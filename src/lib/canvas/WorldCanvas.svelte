<script lang="ts">
	import type { SolverShape, StoredIdentity } from '$lib/model/types';
	import type { RoomStore } from '$lib/store/room-store';
	import { SyncClient } from '$lib/store/sync-client.svelte';
	import { Viewport } from './viewport.svelte';
	import { gridFor } from './grid';
	import {
		shapeOfObject,
		shapeOfParticipant,
		participatesInCollision
	} from '$lib/store/memory-store.svelte';
	import { newNote, newDrawing, maxZOf } from '$lib/model/create';
	import { simplify, strokeBounds, normalizePoints, pointsToPath } from '$lib/model/drawing';
	import type { Bounds } from './geometry';
	import ObjectFrame from './ObjectFrame.svelte';
	import PlacerMarker from './PlacerMarker.svelte';
	import AvatarTile from './AvatarTile.svelte';
	import ObjectContent from '$lib/objects/ObjectContent.svelte';
	import Button from '$lib/ui/Button.svelte';
	import { canDesignRoom, canEdit, canSee } from '$lib/model/permissions';
	import { untrack } from 'svelte';

	interface Props {
		store: RoomStore;
		sync: SyncClient;
		viewport: Viewport;
		identity: StoredIdentity;
		/** Host role in this room (UX-PERM-3), from room_members. */
		isHost?: boolean | undefined;
		drawMode: boolean;
		drawColor: string;
		/**
		 * Live video by participant id (UX-AV-1, UX-ROOM-1).
		 *
		 * Passed down rather than read from a store, because a stream is not room
		 * STATE — it is not persisted, not versioned, and not the same for two
		 * people looking at the same room. Putting it in `room_state` would give
		 * an avatar a creator and a permission, which UX-AV-7 explicitly rejects.
		 */
		videoStreams?: ReadonlyMap<string, MediaStream> | undefined;
		/**
		 * Live screen shares, keyed by the OWNER's participant id (UX-OBJ-6).
		 *
		 * Separate from `videoStreams` because they are keyed the same way and
		 * mean different things — a person can appear in both, and merging them
		 * would put somebody's screen on their face.
		 */
		screenStreams?: ReadonlyMap<string, MediaStream> | undefined;
		/**
		 * Signed URLs for image objects, keyed by Storage path (UX-OBJ-5). Minted
		 * in Room (which owns the Supabase client) and threaded through, so this
		 * renderer needs no live client of its own.
		 */
		imageUrls?: ReadonlyMap<string, string> | undefined;
		/** An image tile's URL failed to load; ask Room to re-mint it (UX-OBJ-5). */
		onImageExpired?: ((path: string) => void) | undefined;
		/** This browser refused OUR camera. Only ever shown on our own tile. */
		cameraDenied?: boolean;
	}

	let {
		store,
		sync,
		viewport,
		identity,
		isHost = false,
		drawMode,
		drawColor,
		videoStreams,
		screenStreams,
		imageUrls,
		onImageExpired,
		cameraDenied = false
	}: Props = $props();

	/**
	 * Display names by participant id, so a share can say whose screen it is.
	 * Derived here rather than threaded from Room: the participants are already
	 * in hand, and a second prop carrying the same fact would drift.
	 */
	const participantNames = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt by the derived, not mutated
		const names = new Map<string, string>();
		for (const participant of Object.values(store.state.participants)) {
			names.set(participant.id, participant.name);
		}
		return names;
	});

	/** Placers are a host tool (UX-AV-2); the role is real now (room_members). */
	const canDesign = $derived(canDesignRoom(isHost));

	let width = $state(1);
	let height = $state(1);
	$effect(() => {
		viewport.size = { width, height };
	});

	const roomBg = $derived(store.state.background === '' ? 'var(--bg-canvas)' : store.state.background);

	// Per-viewer fullscreen (UX-CANVAS-4): local view state, never synced.
	let fullscreenId = $state<string | null>(null);

	// Freehand drawing capture (UX-OBJ-11): world-space points, local view state.
	let stroke = $state<{ x: number; y: number }[] | null>(null);
	const strokePreview = $derived(stroke === null ? '' : pointsToPath(stroke));
	const fullscreenObject = $derived.by(() => {
		if (fullscreenId === null) return null;
		const object = store.state.objects[fullscreenId] ?? null;
		// Hiding an object while it is maximised must close the overlay, not
		// leave it on screen for people who can no longer see the object.
		return object !== null && canSee(object, identity.id, isHost) ? object : null;
	});

	let fullscreenDialog = $state<HTMLDialogElement | null>(null);

	function closeFullscreen(): void {
		fullscreenId = null;
	}

	/**
	 * Drive the native modal from state. The `.open` checks matter: `onclose`
	 * (fired by Escape or the backdrop) sets fullscreenId back to null, and
	 * without the guards this effect would re-enter showModal/close.
	 */
	$effect(() => {
		const dialog = fullscreenDialog;
		if (dialog === null) return;
		if (fullscreenObject !== null && !dialog.open) dialog.showModal();
		else if (fullscreenObject === null && dialog.open) dialog.close();
	});

	const objects = $derived(Object.values(store.state.objects));
	const participants = $derived(Object.values(store.state.participants));

	/**
	 * Visibility forks the object list THREE ways, and conflating any two of
	 * them is how you get an invisible wall:
	 *
	 *  - `rendered`  — what I can see. A hidden object still renders for its
	 *                  creator, ghosted, so hiding is undoable.
	 *  - `occupying` — what takes up space. Hidden objects do NOT: an obstacle
	 *                  nobody can see is worse than an overlap.
	 *  - `framing`   — what auto-zoom fits to. Hidden objects would otherwise
	 *                  drag the camera toward something most people cannot see.
	 */
	const rendered = $derived(objects.filter((o) => canSee(o, identity.id, isHost)));
	const occupying = $derived(objects.filter((o) => !o.hidden && participatesInCollision(o)));

	/** Solver obstacles for a moving id: everything else, settled positions. */
	function obstaclesFor(excludeId: string): () => SolverShape[] {
		return () => [
			...occupying.filter((o) => o.id !== excludeId).map(shapeOfObject),
			...participants.filter((p) => p.id !== excludeId).map(shapeOfParticipant)
		];
	}

	/**
	 * Announce what OTHER people do (UX-A11Y-3).
	 *
	 * Only your own creations and deletions were announced, so a screen-reader
	 * user had no idea the room was changing around them — objects appeared and
	 * vanished silently. Remote changes arrive in the full-state broadcast
	 * rather than as ephemeral messages, so they have to be found by diffing
	 * successive snapshots; there is no event to listen to.
	 *
	 * Deliberately skips your own changes (already announced at the point of
	 * action, with better wording) and stays silent on the FIRST snapshot,
	 * which would otherwise read out the entire room on arrival.
	 */
	let seen: Map<string, { type: string; creator: string }> | null = null;
	$effect(() => {
		const current = new Map(objects.map((o) => [o.id, { type: o.type, creator: o.creator_id }]));
		untrack(() => {
			const previous = seen;
			seen = current;
			if (previous === null) return; // first load: describe nothing
			const nameOf = (id: string): string => store.state.participants[id]?.name ?? 'Someone';
			for (const [id, info] of current) {
				if (!previous.has(id) && info.creator !== identity.id) {
					sync.announce(`${nameOf(info.creator)} added a ${info.type}`);
				}
			}
			for (const [id, info] of previous) {
				if (!current.has(id) && info.creator !== identity.id) {
					sync.announce(`${nameOf(info.creator)}'s ${info.type} was deleted`);
				}
			}
		});
	});

	/** Auto-zoom (UX-CANVAS-3): recompute while engaged, on content/size change. */
	$effect(() => {
		if (!viewport.autoZoom) return;
		const framing = objects.filter((o) => !o.hidden);
		const bounds: Bounds[] = [
			...framing.map((o) => ({
				x: o.transform.x,
				y: o.transform.y,
				width: o.transform.width,
				height: o.transform.height
			})),
			// The participant's OWN size, not the default constant: avatars are
			// resizable (UX-AV-1), so framing by AVATAR_SIZE crops anyone scaled
			// up. The collision path was corrected when resize landed and this
			// one was missed — the same bug in two places, fixed once each.
			...participants.map((p) => ({
				x: p.location.x,
				y: p.location.y,
				width: p.size.width,
				height: p.size.height
			}))
		];
		viewport.fit(bounds);
	});

	/** The dot grid (UX-CANVAS-6); LOD math lives in grid.ts, property-tested. */
	const grid = $derived(gridFor(viewport.camera));

	/* Background pan (per-viewer — UX-CANVAS-2; never enters the store). */
	let panning = $state(false);
	let last = { x: 0, y: 0 };

	function onBackgroundDown(event: PointerEvent): void {
		// Background gestures belong to the background: without this check the
		// canvas captures pointerdowns aimed at the camera cluster, retargeting
		// pointerup and swallowing the buttons' clicks entirely.
		if (event.target !== event.currentTarget) return;
		if (event.currentTarget instanceof HTMLElement) {
			event.currentTarget.setPointerCapture(event.pointerId);
		}
		if (drawMode) {
			stroke = [viewport.toWorld({ x: event.clientX, y: event.clientY })];
			return;
		}
		panning = true;
		last = { x: event.clientX, y: event.clientY };
	}

	function onBackgroundMove(event: PointerEvent): void {
		if (stroke !== null) {
			stroke = [...stroke, viewport.toWorld({ x: event.clientX, y: event.clientY })];
			return;
		}
		if (!panning) return;
		viewport.pan(event.clientX - last.x, event.clientY - last.y);
		last = { x: event.clientX, y: event.clientY };
	}

	function endStroke(): void {
		if (stroke !== null) {
			const pts = simplify(stroke);
			if (pts.length >= 2) {
				const box = strokeBounds(pts);
				void sync.commit({
					kind: 'create_object',
					object: newDrawing(identity.id, box, drawColor, 3, normalizePoints(pts, box), maxZOf(objects))
				});
				sync.announce('Drawing added');
			}
			stroke = null;
		}
		panning = false;
	}

	function onWheel(event: WheelEvent): void {
		event.preventDefault();
		const rect = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : null;
		const point = rect
			? { x: event.clientX - rect.left, y: event.clientY - rect.top }
			: { x: event.clientX, y: event.clientY };
		viewport.zoomAtPoint(point, Math.exp(-event.deltaY * 0.0015));
	}

	function createNoteAt(world: { x: number; y: number }): void {
		const note = newNote(identity.id, world, maxZOf(objects), store.state.border_default);
		void sync.commit({ kind: 'create_object', object: note });
		sync.announce('Note added');
	}

	/** Double-click creates a note (UX-OBJ-9); "+ note" is the keyboard path. */
	function onDoubleClick(event: MouseEvent): void {
		if (event.target !== event.currentTarget) return;
		createNoteAt(viewport.toWorld({ x: event.clientX, y: event.clientY }));
	}

	/**
	 * Canvas-level keyboard (UX-A11Y-2, only when the canvas itself is
	 * focused): arrows pan, +/- zoom about the center, 0 re-fits.
	 */
	function onCanvasKey(event: KeyboardEvent): void {
		if (event.target !== event.currentTarget) return;
		const center = { x: viewport.size.width / 2, y: viewport.size.height / 2 };
		const pan = 40;
		switch (event.key) {
			case 'ArrowLeft':
				viewport.pan(pan, 0);
				break;
			case 'ArrowRight':
				viewport.pan(-pan, 0);
				break;
			case 'ArrowUp':
				viewport.pan(0, pan);
				break;
			case 'ArrowDown':
				viewport.pan(0, -pan);
				break;
			case '+':
			case '=':
				viewport.zoomAtPoint(center, 1.2);
				break;
			case '-':
				viewport.zoomAtPoint(center, 1 / 1.2);
				break;
			case '0':
				viewport.autoZoom = true;
				break;
			default:
				return;
		}
		event.preventDefault();
	}
</script>

<!--
	role="application" is ARIA's sanctioned container for widgets with custom
	keyboard handling (arrows pan, +/- zoom); the compiler's interactive-role
	list just doesn't include it. Verified by axe in e2e/a11y.e2e.ts; logged in
	STYLE.md §10.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	class="canvas"
	class:draw-mode={drawMode}
	role="application"
	aria-label="Room canvas"
	tabindex="0"
	bind:clientWidth={width}
	bind:clientHeight={height}
	style:background={roomBg}
	style:cursor={drawMode ? 'crosshair' : null}
	onwheel={onWheel}
	onpointerdown={onBackgroundDown}
	onpointermove={onBackgroundMove}
	onpointerup={endStroke}
	onpointercancel={endStroke}
	ondblclick={onDoubleClick}
	onkeydown={onCanvasKey}
>
	<!-- Grid is its own layer so the room background (UX-CANVAS-5) shows behind
	     it; decorative, so aria-hidden and pointer-transparent. -->
	<div
		class="grid"
		aria-hidden="true"
		style:background-size="{grid.px}px {grid.px}px"
		style:background-position="{grid.x}px {grid.y}px"
	></div>
	<!-- AR-CANVAS-1: one transformed world layer; pan/zoom mutate this
	     container's transform, never the objects. -->
	<div
		class="world"
		class:animated={viewport.animating}
		style:transform="translate({viewport.camera.x}px, {viewport.camera.y}px) scale({viewport.camera.scale})"
	>
		<!-- Newcomer placers (UX-AV-2). In the world layer so they pan and scale
		     with content, but they are markers, not objects: they hold no space
		     and are not part of any object layout.

		     Host-only by requirement. `isHost` is false everywhere until the
		     role arrives with admission, and gating on it now would make these
		     invisible to everyone and therefore impossible to position — the
		     same defect as a create_permission that admits nobody. So the gate
		     is written where it belongs and left inert, exactly as canEdit and
		     canSee already do. -->
		{#if canDesign}
			{#each store.state.placers as placer, index (placer.id)}
				<PlacerMarker {placer} number={index + 1} {sync} {viewport} />
			{/each}
		{/if}

		{#each rendered as object (object.id)}
			<ObjectFrame
				{object}
				{isHost}
				{store}
				{sync}
				{viewport}
				{identity}
				{screenStreams}
				names={participantNames}
				{imageUrls}
				{onImageExpired}
				obstacles={obstaclesFor(object.id)}
				onFullscreen={(id: string) => {
					fullscreenId = id;
				}}
			/>
		{/each}
		{#each participants as participant (participant.id)}
			<AvatarTile
				{participant}
				{store}
				{sync}
				{viewport}
				obstacles={obstaclesFor(participant.id)}
				isSelf={participant.id === identity.id}
				videoStream={videoStreams?.get(participant.id)}
				{cameraDenied}
			/>
		{/each}
		{#if stroke !== null}
			<svg class="stroke-preview" aria-hidden="true">
				<path
					d={strokePreview}
					fill="none"
					stroke={drawColor}
					stroke-width="3"
					stroke-linecap="round"
					vector-effect="non-scaling-stroke"
				/>
			</svg>
		{/if}
	</div>

	<!-- Camera controls live in the single bottom toolbar (BottomBar) now. -->

	<!--
		Fullscreen (UX-CANVAS-4): per-viewer, mutates nothing shared.

		A MODAL <dialog>, not a positioned div. showModal() puts it in the top
		layer, which is the only way it can paint above the page chrome: the
		overlay is nested inside `main`, so however high its z-index went, a
		fixed toolbar in the ROOT stacking context still covered it — hence
		"maximize is occluded by the floating menus". The modal also brings
		native Escape, a backdrop, and inerting of the rest of the page, which
		replaces a hand-rolled key handler and a focus helper that had no
		focus trap at all.
	-->
	<dialog bind:this={fullscreenDialog} class="fullscreen" aria-label="Fullscreen object" onclose={closeFullscreen}>
		{#if fullscreenObject !== null}
			<Button label="Exit fullscreen" onclick={closeFullscreen}>✕ close</Button>
			<div class="fs-content">
				<ObjectContent
					object={fullscreenObject}
					{sync}
					editable={canEdit(fullscreenObject, identity.id, isHost)}
					{identity}
					{screenStreams}
					names={participantNames}
					{imageUrls}
					{onImageExpired}
					onexit={closeFullscreen}
				/>
			</div>
		{/if}
	</dialog>
</div>

<style>
	.canvas {
		position: absolute;
		inset: 0;
		overflow: hidden;
		background: var(--bg-canvas);
		touch-action: none;
		/* Contain the world's stacking context. Per-object z comes from maxZOf
		   and grows without bound; before this, those values competed directly
		   with page chrome in the root stacking context, which is why chrome
		   had to bid 10000 to stay on top. Isolated, chrome needs only --z-chrome. */
		isolation: isolate;
		/* Dragging the background pans the camera, so say so (UX-CANVAS-1). */
		/* grab/grabbing is the CANVAS gesture: you seize the surface and pull
		   it. Objects use `move`, so the pointer says which of the two will
		   happen before you press — there was no cue at all when both used
		   grab. */
		cursor: grab;
	}
	.canvas:active {
		cursor: grabbing;
	}
	/*
	 * Draw mode makes the WHOLE canvas a drawing surface, objects included.
	 * Two things otherwise swallowed a stroke that started over an object: the
	 * frame stops pointerdown propagation to begin a drag, and onBackgroundDown
	 * ignores events whose target is a child. Making content pointer-transparent
	 * for the duration fixes both at once and needs no special case in either
	 * handler — the event simply arrives at the canvas, as it does over empty
	 * space. Ink belongs on top of what it annotates, and drawings are exempt
	 * from collision (UX-OBJ-12), so there is nothing to arbitrate.
	 */
	.canvas.draw-mode :global(.frame),
	.canvas.draw-mode :global(.avatar) {
		pointer-events: none;
	}
	.grid {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background-image: radial-gradient(circle, var(--grid-dot) 8%, transparent 9%);
	}
	.world {
		position: absolute;
		left: 0;
		top: 0;
		transform-origin: 0 0;
	}
	.world.animated {
		transition: transform 240ms ease;
	}
	.stroke-preview {
		position: absolute;
		left: 0;
		top: 0;
		overflow: visible;
		pointer-events: none;
	}
	.fullscreen {
		/* The top layer handles stacking; a z-index here would be meaningless. */
		width: 100vw;
		max-width: 100vw;
		height: 100vh;
		max-height: 100vh;
		margin: 0;
		padding: var(--space-3);
		box-sizing: border-box;
		border: none;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		background: var(--bg-canvas);
		color: var(--text);
	}
	.fullscreen:not([open]) {
		display: none;
	}
	.fullscreen::backdrop {
		background: var(--bg-canvas);
	}
	.fs-content {
		flex: 1;
		min-height: 0;
		margin: 0 var(--space-6) var(--space-6);
		border-radius: var(--radius-lg);
		overflow: hidden;
		box-shadow: var(--shadow-2);
	}
</style>
