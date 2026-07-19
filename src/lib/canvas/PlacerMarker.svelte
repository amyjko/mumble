<script lang="ts">
	import type { Placer, Point, Transform } from '$lib/model/types';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import type { Viewport } from './viewport.svelte';
	import TransformHandles from './TransformHandles.svelte';
	import { nextClip, outlineFor } from '$lib/model/clip';
	import { resizeTransform, rotationForPointer, snapRotation, type ResizeHandle } from './resize';
	import { hint, SNAP_HINT } from './hint.svelte';
	import { stopPointer } from '$lib/ui/events';
	import Button from '$lib/ui/Button.svelte';
	import { RAISED_Z } from './layers';

	/**
	 * A newcomer placer (UX-AV-2): where arrivals appear, and what they look
	 * like when they do.
	 *
	 * This replaces a single unexplained dashed circle. That design was weak in
	 * three ways at once — it was unlabelled, so nothing said what it was; it
	 * was a bare point, so its one visual property (a radius) meant nothing;
	 * and it was visible to everyone, so every participant saw a control only a
	 * host would ever use.
	 *
	 * A placer is transformable like everything else on the canvas, and that is
	 * load-bearing rather than consistency for its own sake: whoever lands here
	 * ADOPTS this size, rotation, and shape. Resizing a placer resizes the
	 * person who arrives in it.
	 *
	 * Still not an object: it holds no space in the solver, carries no
	 * permission, and never enters a configuration's object layout.
	 */

	/** A placer smaller than this cannot hold a recognisable face. */
	const MIN_PLACER = 56;

	interface Props {
		placer: Placer;
		/** 1-based position, which IS the number shown. Never stored — see schemas. */
		number: number;
		sync: SyncClient;
		viewport: Viewport;
	}

	let { placer, number, sync, viewport }: Props = $props();

	const label = $derived(`Newcomer ${String(number)}`);

	let liveTransform = $state<Transform | null>(null);
	const shown = $derived({
		x: liveTransform?.x ?? placer.x,
		y: liveTransform?.y ?? placer.y,
		width: liveTransform?.width ?? placer.width,
		height: liveTransform?.height ?? placer.height,
		rotation: liveTransform?.rotation ?? placer.rotation
	});
	/**
	 * A STROKED outline, not a clipped bordered box. clip-path removes a border
	 * rather than bending it — the same failure the sticker border had — and the
	 * ring trick that fixed it there cannot be dashed. Stroking the real path is
	 * the only way to get a dashed edge that follows an ellipse or a hexagon.
	 */
	const outline = $derived(outlineFor(placer.clip, shown.width, shown.height));

	function commit(next: Partial<Placer>): void {
		void sync.commit({ kind: 'update_placer', placer: { ...placer, ...next } });
	}

	// ---- drag ----
	let dragging = $state(false);
	let pointerStart: Point = { x: 0, y: 0 };
	let start: Point = { x: 0, y: 0 };
	let preview = $state<Point | null>(null);

	function onPointerDown(event: PointerEvent): void {
		event.stopPropagation();
		selected = true;
		dragging = true;
		pointerStart = viewport.toWorld({ x: event.clientX, y: event.clientY });
		start = { x: placer.x, y: placer.y };
		preview = start;
		hint.show(SNAP_HINT);
		if (event.currentTarget instanceof HTMLElement) {
			event.currentTarget.setPointerCapture(event.pointerId);
		}
	}

	function onPointerMove(event: PointerEvent): void {
		if (!dragging) return;
		const world = viewport.toWorld({ x: event.clientX, y: event.clientY });
		// No solver: a placer holds no space, so it may sit anywhere — including
		// under content, where it simply will not be chosen for an arrival.
		preview = {
			x: start.x + (world.x - pointerStart.x),
			y: start.y + (world.y - pointerStart.y)
		};
	}

	function onPointerUp(): void {
		if (!dragging) return;
		dragging = false;
		hint.clear();
		if (preview !== null) commit(preview);
		preview = null;
	}

	// ---- resize / rotate, the same gestures as an object ----
	let handleKind: ResizeHandle | 'rotate' | null = null;
	let handleStart: Transform = { x: 0, y: 0, width: 0, height: 0, rotation: 0, z: 0 };
	let handleLast: Transform = handleStart;
	let handlePointer: Point = { x: 0, y: 0 };

	function onHandleMove(event: PointerEvent): void {
		if (handleKind === null) return;
		const world = viewport.toWorld({ x: event.clientX, y: event.clientY });
		if (handleKind === 'rotate') {
			const degrees = rotationForPointer(handleStart, world);
			handleLast = { ...handleStart, rotation: snapRotation(degrees, event.shiftKey) };
		} else {
			handleLast = resizeTransform(
				handleStart,
				handleKind,
				world.x - handlePointer.x,
				world.y - handlePointer.y,
				event.shiftKey,
				{ width: MIN_PLACER, height: MIN_PLACER }
			);
		}
		liveTransform = handleLast;
	}

	function onHandleUp(): void {
		window.removeEventListener('pointermove', onHandleMove);
		hint.clear();
		if (handleKind === null) return;
		handleKind = null;
		commit({
			x: handleLast.x,
			y: handleLast.y,
			width: handleLast.width,
			height: handleLast.height,
			rotation: handleLast.rotation
		});
		liveTransform = null;
	}

	function onHandleDown(kind: ResizeHandle | 'rotate', event: PointerEvent): void {
		event.stopPropagation();
		handleKind = kind;
		handleStart = { ...shown, z: 0 };
		handleLast = handleStart;
		handlePointer = viewport.toWorld({ x: event.clientX, y: event.clientY });
		hint.show(SNAP_HINT);
		window.addEventListener('pointermove', onHandleMove);
		window.addEventListener('pointerup', onHandleUp, { once: true });
	}

	/** Keyboard parity (UX-A11Y-2): the same vocabulary objects and avatars use. */
	function onKeyDown(event: KeyboardEvent): void {
		if (event.target !== event.currentTarget) return;
		const step = event.shiftKey ? 1 : 16;

		if (event.altKey && event.key.startsWith('Arrow')) {
			const grow = event.key === 'ArrowRight' || event.key === 'ArrowDown';
			const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
			event.preventDefault();
			commit({
				width: horizontal
					? Math.max(MIN_PLACER, placer.width + (grow ? step : -step))
					: placer.width,
				height: horizontal
					? placer.height
					: Math.max(MIN_PLACER, placer.height + (grow ? step : -step))
			});
			return;
		}
		if (event.key === '[' || event.key === ']') {
			event.preventDefault();
			commit({ rotation: placer.rotation + (event.key === ']' ? 15 : -15) });
			return;
		}
		if (event.key === 'c') {
			event.preventDefault();
			commit({ clip: nextClip(placer.clip) });
			return;
		}
		const delta: Record<string, Point> = {
			ArrowLeft: { x: -step, y: 0 },
			ArrowRight: { x: step, y: 0 },
			ArrowUp: { x: 0, y: -step },
			ArrowDown: { x: 0, y: step }
		};
		const move = delta[event.key];
		if (move === undefined) return;
		event.preventDefault();
		commit({ x: placer.x + move.x, y: placer.y + move.y });
	}

	/**
	 * SELECTION, not just hover.
	 *
	 * Hover alone made the controls unusable: the chrome sits outside the box,
	 * so travelling from the placer to its own buttons crosses a gap where the
	 * pointer is over neither — hover ends, the chrome unmounts, and the button
	 * is gone before it can be pressed. A control you can see and never click
	 * is worse than no control.
	 *
	 * Clicking a placer selects it and the chrome stays put until you click
	 * away or press Escape. Hover still reveals, so the affordance is
	 * discoverable; selection is what makes it reachable.
	 */
	let selected = $state(false);
	let hovered = $state(false);
	const active = $derived(selected || hovered);
	let root = $state<HTMLElement | null>(null);

	/**
	 * Raised above avatars while active (the UX-OBJ-14 rule). A placer rests
	 * BELOW avatars by design, so someone standing in it covers its own
	 * controls — exactly when a host wants to adjust it.
	 */
	$effect(() => {
		if (!selected) return;
		const onDown = (event: PointerEvent): void => {
			const target = event.target;
			if (target instanceof Node && root?.contains(target) === true) return;
			selected = false;
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') selected = false;
		};
		window.addEventListener('pointerdown', onDown);
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('pointerdown', onDown);
			window.removeEventListener('keydown', onKey);
		};
	});

	function cycleShape(): void {
		const clip = nextClip(placer.clip);
		commit({ clip });
		sync.announce(`${label} shape: ${clip.shape}`);
	}

	function remove(): void {
		void sync.commit({ kind: 'remove_placer', id: placer.id });
		sync.announce(`${label} removed`);
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	class="placer"
	class:dragging
	role="group"
	aria-label="{label} — where the next arrival appears"
	tabindex="0"
	style:z-index={active ? RAISED_Z : 900}
	style:transform="translate({preview?.x ?? shown.x}px, {preview?.y ?? shown.y}px) rotate({shown.rotation}deg)"
	style:width="{shown.width}px"
	style:height="{shown.height}px"
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
	onkeydown={onKeyDown}
	bind:this={root}
	class:active
	onpointerenter={() => (hovered = true)}
	onpointerleave={() => (hovered = false)}
	onfocusin={() => (selected = true)}
>
	<svg class="outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
		{#if outline.kind === 'ellipse'}
			<ellipse cx="50" cy="50" rx="49" ry="49" vector-effect="non-scaling-stroke" />
		{:else if outline.kind === 'polygon'}
			<polygon
				points={outline.points.map((p) => `${String(p.x)},${String(p.y)}`).join(' ')}
				vector-effect="non-scaling-stroke"
			/>
		{:else}
			<rect
				x="1"
				y="1"
				width="98"
				height="98"
				rx={outline.rx}
				ry={outline.ry}
				vector-effect="non-scaling-stroke"
			/>
		{/if}
	</svg>
	<!-- Labelled, because an unexplained dashed shape is a puzzle, not a hint. -->
	<span class="tag" aria-hidden="true">{label}</span>
	<TransformHandles {onHandleDown} subject="placer" />
	<!--
		Chrome only while hovered or focused. It sits OUTSIDE the box, so a
		neighbouring placer's buttons otherwise cover this one — placers are laid
		down adjacent to each other, so that is the normal case, not an edge one.
		It also keeps a room with eight spots from being littered with buttons.
	-->
	{#if active}
	<span class="chrome">
		<Button
			variant="chrome"
			shape="icon"
			label="Change {label} shape (currently {placer.clip.shape})"
			onpointerdown={stopPointer}
			onclick={cycleShape}>◇</Button
		>
		<Button variant="chrome" shape="icon" label="Remove {label}" onclick={remove} onpointerdown={stopPointer}>
			×
		</Button>
	</span>
	{/if}
</div>

<style>
	.placer {
		position: absolute;
		left: 0;
		top: 0;
		/* Resting below avatars (1000): this marks where people go, it is not a
		   person. Raised above them on hover/focus so its controls stay
		   reachable even when someone is standing in it. */
		cursor: grab;
		touch-action: none;
	}
	.placer.dragging {
		cursor: grabbing;
	}
	.outline {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		overflow: visible;
		/* Faint: it is scaffolding for a host, never content. */
		opacity: 0.5;
	}
	.outline :global(*) {
		fill: none;
		stroke: var(--border-strong);
		stroke-width: 2;
		stroke-dasharray: 6 4;
	}
	.placer:hover .outline,
	.placer:focus-visible .outline,
	.placer.active .outline {
		opacity: 1;
	}

	/*
	 * Reveal the transform grips. TransformHandles ships them at opacity 0 and
	 * relies on the PARENT to show them — ObjectFrame has this rule and this
	 * component did not, so the rotate grip was invisible: a control that
	 * existed in the DOM, answered to the keyboard, and could not be seen.
	 */
	.placer.active :global(.resize),
	.placer.active :global(.rotate),
	.placer:hover :global(.resize),
	.placer:hover :global(.rotate) {
		opacity: 1;
	}
	.placer:hover .outline :global(*),
	.placer:focus-visible .outline :global(*) {
		stroke: var(--accent);
	}
	.tag {
		position: absolute;
		left: 50%;
		top: 50%;
		translate: -50% -50%;
		font-size: var(--text-sm);
		color: var(--text-muted);
		white-space: nowrap;
		pointer-events: none;
	}
	/*
	 * Chrome sits BELOW the box. The four corners belong to resize handles and
	 * the space directly above belongs to the rotate grip — putting controls
	 * there made the remove button and the grip overlap, so a host aiming at
	 * one hit the other.
	 */
	.chrome {
		position: absolute;
		/* Bridges the gap between the box and the buttons: without it the
		   pointer crosses dead space on the way down, and on a hover-only
		   reveal the chrome vanishes mid-journey. */
		padding-top: var(--space-1);
		top: 100%;
		left: 50%;
		translate: -50% 0;
		/* A row with a real gap, rather than two hand-placed offsets: those
		   overlapped each other, so aiming at one hit the other. */
		display: flex;
		gap: var(--space-1);
	}
</style>
