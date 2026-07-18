<script lang="ts">
	import type { ResizeHandle } from './resize';

	/**
	 * The four corner resize grips and the rotate grip, shared by ObjectFrame
	 * and AvatarTile. Extracted when avatars gained resize/rotate: two copies of
	 * fiddly overhanging, hover-revealed, focus-visible handles would drift
	 * apart immediately.
	 *
	 * These must be rendered as SIBLINGS of a clipped layer, never inside it —
	 * clip-path clips hit-testing for descendants, which is what previously
	 * made an ellipse-clipped object impossible to resize or reshape.
	 */

	interface Props {
		onHandleDown: (kind: ResizeHandle | 'rotate', event: PointerEvent) => void;
		/** Names the thing being resized, so the grips aren't all "Resize from nw". */
		subject: string;
	}

	let { onHandleDown, subject }: Props = $props();
</script>

{#each ['nw', 'ne', 'sw', 'se'] as const as handle (handle)}
	<button
		class="resize {handle}"
		aria-label="Resize {subject} from {handle}"
		onpointerdown={(event) => {
			onHandleDown(handle, event);
		}}
	></button>
{/each}
<button
	class="rotate"
	aria-label="Rotate {subject}"
	onpointerdown={(event) => {
		onHandleDown('rotate', event);
	}}
></button>

<style>
	.resize,
	.rotate {
		position: absolute;
		width: var(--space-3);
		height: var(--space-3);
		padding: 0;
		border: 1px solid var(--accent);
		background: var(--surface);
		opacity: 0;
		transition: opacity 120ms;
	}
	/* Visible whenever focused, even before the parent's hover reveal — a
	   keyboard user must see the grip they just tabbed to. */
	.resize:focus-visible,
	.rotate:focus-visible {
		opacity: 1;
	}
	.resize {
		border-radius: 2px;
	}
	.resize.nw {
		top: calc(-1 * var(--space-1));
		left: calc(-1 * var(--space-1));
		cursor: nwse-resize;
	}
	.resize.ne {
		top: calc(-1 * var(--space-1));
		right: calc(-1 * var(--space-1));
		cursor: nesw-resize;
	}
	.resize.sw {
		bottom: calc(-1 * var(--space-1));
		left: calc(-1 * var(--space-1));
		cursor: nesw-resize;
	}
	.resize.se {
		bottom: calc(-1 * var(--space-1));
		right: calc(-1 * var(--space-1));
		cursor: nwse-resize;
	}
	.rotate {
		top: calc(-1 * var(--space-6));
		left: 50%;
		transform: translateX(-50%);
		border-radius: var(--radius-full);
		cursor: grab;
	}
</style>
