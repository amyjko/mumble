<script lang="ts">
	import type { SolverShape, StoredIdentity } from '$lib/model/types';
	import type { RoomStore } from '$lib/store/room-store';
	import { SyncClient } from '$lib/store/sync-client.svelte';
	import { Viewport } from './viewport.svelte';
	import { shapeOfObject, shapeOfParticipant, AVATAR_SIZE } from '$lib/store/memory-store.svelte';
	import { newNote, maxZOf } from '$lib/model/create';
	import type { Bounds } from './geometry';
	import ObjectFrame from './ObjectFrame.svelte';
	import AvatarTile from './AvatarTile.svelte';

	interface Props {
		store: RoomStore;
		sync: SyncClient;
		viewport: Viewport;
		identity: StoredIdentity;
	}

	let { store, sync, viewport, identity }: Props = $props();

	let width = $state(1);
	let height = $state(1);
	$effect(() => {
		viewport.size = { width, height };
	});

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
		panning = true;
		last = { x: event.clientX, y: event.clientY };
		if (event.currentTarget instanceof HTMLElement) {
			event.currentTarget.setPointerCapture(event.pointerId);
		}
	}

	function onBackgroundMove(event: PointerEvent): void {
		if (!panning) return;
		viewport.pan(event.clientX - last.x, event.clientY - last.y);
		last = { x: event.clientX, y: event.clientY };
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
	style:background-size="{grid.px}px {grid.px}px"
	style:background-position="{grid.x}px {grid.y}px"
	onwheel={onWheel}
	onpointerdown={onBackgroundDown}
	onpointermove={onBackgroundMove}
	onpointerup={() => (panning = false)}
	onpointercancel={() => (panning = false)}
	ondblclick={onDoubleClick}
	onkeydown={onCanvasKey}
>
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
			/>
		{/each}
		{#each participants as participant (participant.id)}
			<AvatarTile {participant} {store} {sync} {viewport} obstacles={obstaclesFor(participant.id)} />
		{/each}
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
</div>

<style>
	.canvas {
		position: absolute;
		inset: 0;
		overflow: hidden;
		background-color: var(--bg-canvas);
		background-image: radial-gradient(circle, var(--grid-dot) 8%, transparent 9%);
		touch-action: none;
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
</style>
