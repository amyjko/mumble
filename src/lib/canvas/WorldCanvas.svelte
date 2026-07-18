<script lang="ts">
	import type { SolverShape, StoredIdentity } from '$lib/model/types';
	import type { RoomStore } from '$lib/store/room-store';
	import { SyncClient } from '$lib/store/sync-client.svelte';
	import { Viewport } from './viewport.svelte';
	import { shapeOfObject, shapeOfParticipant, AVATAR_SIZE } from '$lib/store/memory-store.svelte';
	import { newNote, newDrawing, maxZOf } from '$lib/model/create';
	import { simplify, strokeBounds, normalizePoints, pointsToPath } from '$lib/model/drawing';
	import type { Bounds } from './geometry';
	import ObjectFrame from './ObjectFrame.svelte';
	import AvatarTile from './AvatarTile.svelte';
	import ObjectContent from '$lib/objects/ObjectContent.svelte';

	interface Props {
		store: RoomStore;
		sync: SyncClient;
		viewport: Viewport;
		identity: StoredIdentity;
		drawMode: boolean;
		drawColor: string;
	}

	let { store, sync, viewport, identity, drawMode, drawColor }: Props = $props();

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
	function focusOnMount(node: HTMLElement): void {
		node.focus();
	}
	const fullscreenObject = $derived(fullscreenId === null ? null : (store.state.objects[fullscreenId] ?? null));

	const objects = $derived(Object.values(store.state.objects));
	const participants = $derived(Object.values(store.state.participants));

	/** Solver obstacles for a moving id: everything else, settled positions. */
	function obstaclesFor(excludeId: string): () => SolverShape[] {
		return () => [
			...objects.filter((o) => o.id !== excludeId).map(shapeOfObject),
			...participants.filter((p) => p.id !== excludeId).map(shapeOfParticipant)
		];
	}

	/** Auto-zoom (UX-CANVAS-3): recompute while engaged, on content/size change. */
	$effect(() => {
		if (!viewport.autoZoom) return;
		const bounds: Bounds[] = [
			...objects.map((o) => ({
				x: o.transform.x,
				y: o.transform.y,
				width: o.transform.width,
				height: o.transform.height
			})),
			...participants.map((p) => ({
				x: p.location.x,
				y: p.location.y,
				width: AVATAR_SIZE,
				height: AVATAR_SIZE
			}))
		];
		viewport.fit(bounds);
	});

	/**
	 * The dot grid lives in world space: position/scale track the camera so
	 * dots stay glued to world coordinates, with level-of-detail doubling so
	 * effective spacing stays in ~14–56px at any zoom. Decorative (contrast
	 * exemption logged in STYLE.md).
	 */
	const grid = $derived.by(() => {
		let spacing = 24;
		let px = spacing * viewport.camera.scale;
		while (px < 14) {
			spacing *= 2;
			px = spacing * viewport.camera.scale;
		}
		while (px > 56) {
			spacing /= 2;
			px = spacing * viewport.camera.scale;
		}
		return { px, x: viewport.camera.x, y: viewport.camera.y };
	});

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
		const note = newNote(identity.id, world, maxZOf(objects));
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
	STYLE.md §9.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	class="canvas"
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
		{#each objects as object (object.id)}
			<ObjectFrame
				{object}
				{store}
				{sync}
				{viewport}
				{identity}
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

	<!-- Camera cluster: auto-fit is a visible MODE, not a hidden state. -->
	<div class="camera-cluster">
		<span class="zoom" aria-label="Zoom level">{Math.round(viewport.camera.scale * 100)}%</span>
		<button
			class="fit"
			aria-pressed={viewport.autoZoom}
			onclick={() => (viewport.autoZoom = !viewport.autoZoom)}
		>
			⤢ auto-fit {viewport.autoZoom ? 'on' : 'off'}
		</button>
	</div>

	{#if fullscreenObject !== null}
		<!-- Fullscreen overlay (UX-CANVAS-4): per-viewer, mutates nothing shared.
		     Escape or the close button restores the prior view. -->
		<div
			class="fullscreen-overlay"
			role="dialog"
			aria-modal="true"
			aria-label="Fullscreen object"
			tabindex="-1"
			use:focusOnMount
			onkeydown={(e) => {
				if (e.key === 'Escape') fullscreenId = null;
			}}
		>
			<button class="fs-close" aria-label="Exit fullscreen" onclick={() => (fullscreenId = null)}>✕ close</button>
			<div class="fs-content">
				<ObjectContent
					object={fullscreenObject}
					{sync}
					editable={fullscreenObject.creator_id === identity.id || fullscreenObject.permission === 'all'}
					{identity}
					onexit={() => (fullscreenId = null)}
				/>
			</div>
		</div>
	{/if}
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
		cursor: grab;
	}
	.canvas:active {
		cursor: grabbing;
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
	.camera-cluster {
		position: absolute;
		right: var(--space-3);
		bottom: var(--space-3);
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface);
		box-shadow: var(--shadow-1);
	}
	.zoom {
		font-size: var(--text-sm);
		color: var(--text-muted);
		min-width: 40px;
		text-align: right;
	}
	.fit {
		min-height: var(--target-min);
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		color: var(--text);
		font-size: var(--text-sm);
		cursor: pointer;
	}
	.fit[aria-pressed='true'] {
		background: var(--accent);
		color: var(--accent-contrast);
		border-color: var(--accent);
	}
	.fullscreen-overlay {
		position: absolute;
		inset: 0;
		z-index: var(--z-overlay);
		display: flex;
		flex-direction: column;
		background: var(--bg-canvas);
	}
	.fs-close {
		align-self: flex-end;
		margin: var(--space-3);
		min-height: var(--target-min);
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		font: var(--text-sm) var(--font-ui);
		cursor: pointer;
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
