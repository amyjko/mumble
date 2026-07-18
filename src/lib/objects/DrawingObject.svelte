<script lang="ts">
	import type { DrawingCanvasObject } from '$lib/model/types';
	import { pointsToPath } from '$lib/model/drawing';

	interface Props {
		object: DrawingCanvasObject;
	}
	let { object }: Props = $props();
	const d = $derived(pointsToPath(object.payload.points));
</script>

<!-- viewBox 0–100 with non-uniform scaling; non-scaling-stroke keeps the line
     a constant width regardless of the object's size (UX-OBJ-11). -->
<svg class="drawing" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
	<path
		{d}
		fill="none"
		stroke={object.payload.color}
		stroke-width={object.payload.width}
		stroke-linecap="round"
		stroke-linejoin="round"
		vector-effect="non-scaling-stroke"
	/>
</svg>

<style>
	.drawing {
		width: 100%;
		height: 100%;
		display: block;
		overflow: visible;
	}
</style>
