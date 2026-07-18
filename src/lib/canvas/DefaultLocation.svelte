<script lang="ts">
	import type { Point } from '$lib/model/types';
	import type { RoomStore } from '$lib/store/room-store';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import type { Viewport } from './viewport.svelte';

	/**
	 * The configuration's drop-in point (UX-AV-2): where a participant appears
	 * when they have no remembered location here.
	 *
	 * A MARKER, not an object, which the glossary is explicit about and which
	 * has consequences worth stating: it holds no space in the solver, carries
	 * no permission, cannot be deleted like content, and is never part of a
	 * configuration's object layout. It is a property OF the configuration that
	 * happens to be positioned.
	 *
	 * Rendered inside the world layer so it pans and scales with everything
	 * else, but below avatars — it is a hint about where people go, not a
	 * participant.
	 */

	interface Props {
		store: RoomStore;
		sync: SyncClient;
		viewport: Viewport;
	}

	let { store, sync, viewport }: Props = $props();

	const location = $derived(store.state.default_location);

	let dragging = $state(false);
	let pointerStart: Point = { x: 0, y: 0 };
	let markerStart: Point = { x: 0, y: 0 };
	/** Local preview while dragging; committed on release. */
	let preview = $state<Point | null>(null);
	const shown = $derived(preview ?? location);

	function onPointerDown(event: PointerEvent): void {
		event.stopPropagation();
		dragging = true;
		pointerStart = viewport.toWorld({ x: event.clientX, y: event.clientY });
		markerStart = { ...location };
		preview = markerStart;
		if (event.currentTarget instanceof HTMLElement) {
			event.currentTarget.setPointerCapture(event.pointerId);
		}
	}

	function onPointerMove(event: PointerEvent): void {
		if (!dragging) return;
		const world = viewport.toWorld({ x: event.clientX, y: event.clientY });
		preview = {
			x: markerStart.x + (world.x - pointerStart.x),
			y: markerStart.y + (world.y - pointerStart.y)
		};
	}

	function commit(next: Point): void {
		void sync.commit({ kind: 'set_default_location', location: next });
		sync.announce('Drop-in point moved');
	}

	function onPointerUp(): void {
		if (!dragging) return;
		dragging = false;
		if (preview !== null) commit(preview);
		preview = null;
	}

	/** Keyboard parity (UX-A11Y-2): the marker moves by arrows like anything else. */
	function onKeyDown(event: KeyboardEvent): void {
		if (event.target !== event.currentTarget) return;
		const step = event.shiftKey ? 1 : 16;
		const delta: Record<string, Point> = {
			ArrowLeft: { x: -step, y: 0 },
			ArrowRight: { x: step, y: 0 },
			ArrowUp: { x: 0, y: -step },
			ArrowDown: { x: 0, y: step }
		};
		const move = delta[event.key];
		if (move === undefined) return;
		event.preventDefault();
		commit({ x: location.x + move.x, y: location.y + move.y });
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	class="drop-in"
	class:dragging
	role="group"
	aria-label="Drop-in point — where people appear in this configuration"
	tabindex="0"
	style:transform="translate({shown.x}px, {shown.y}px)"
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
	onkeydown={onKeyDown}
>
	<span class="ring" aria-hidden="true"></span>
</div>

<style>
	.drop-in {
		position: absolute;
		left: 0;
		top: 0;
		/* Below avatars (1000): this marks where people go, it is not a person. */
		z-index: 900;
		width: var(--space-8);
		height: var(--space-8);
		display: grid;
		place-items: center;
		cursor: grab;
		touch-action: none;
	}
	.drop-in.dragging {
		cursor: grabbing;
	}
	.ring {
		width: 100%;
		height: 100%;
		border: 2px dashed var(--border-strong);
		border-radius: var(--radius-full);
		/* Deliberately faint: it is a hint, and it must not read as content. */
		opacity: 0.55;
	}
	.drop-in:hover .ring,
	.drop-in:focus-visible .ring {
		border-color: var(--accent);
		opacity: 1;
	}
</style>
