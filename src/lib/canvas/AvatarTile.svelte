<script lang="ts">
	import type { Participant, Point, SolverShape } from '$lib/model/types';
	import type { RoomStore } from '$lib/store/room-store';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import type { Viewport } from './viewport.svelte';
	import { resolveMove } from './geometry';
	import { AVATAR_SIZE, AVATAR_BORDER, shapeOfParticipant } from '$lib/store/memory-store.svelte';

	interface Props {
		participant: Participant;
		store: RoomStore;
		sync: SyncClient;
		viewport: Viewport;
		obstacles: () => SolverShape[];
	}

	let { participant, store, sync, viewport, obstacles }: Props = $props();

	/** Placement is shared state (UX-AV-2); in-flight drags overlay it. */
	const effective = $derived(sync.participantOverlays.get(participant.id) ?? participant.location);

	let dragging = $state(false);
	let pointerStart: Point = { x: 0, y: 0 };
	let tileStart: Point = { x: 0, y: 0 };
	let lastResolved: Point = { x: 0, y: 0 };
	let lastEphemeralAt = 0;

	function onPointerDown(event: PointerEvent): void {
		event.stopPropagation();
		dragging = true;
		pointerStart = viewport.toWorld({ x: event.clientX, y: event.clientY });
		tileStart = { ...effective };
		lastResolved = tileStart;
		if (event.currentTarget instanceof HTMLElement) {
			event.currentTarget.setPointerCapture(event.pointerId);
		}
	}

	function onPointerMove(event: PointerEvent): void {
		if (!dragging) return;
		const world = viewport.toWorld({ x: event.clientX, y: event.clientY });
		const desired = {
			x: tileStart.x + (world.x - pointerStart.x),
			y: tileStart.y + (world.y - pointerStart.y)
		};
		const moving: SolverShape = { ...shapeOfParticipant(participant), x: lastResolved.x, y: lastResolved.y };
		lastResolved = resolveMove(moving, desired, obstacles());
		sync.participantOverlays.set(participant.id, lastResolved);
		const now = performance.now();
		if (now - lastEphemeralAt > 50) {
			lastEphemeralAt = now;
			store.sendEphemeral({ kind: 'drag_participant', id: participant.id, location: lastResolved });
		}
	}

	function onPointerUp(): void {
		if (!dragging) return;
		dragging = false;
		void sync.commit(
			{ kind: 'move_participant', id: participant.id, location: lastResolved },
			participant.id
		);
	}

	/** Keyboard movement (UX-A11Y-2): same solver, debounced commit. */
	let keyboardPosition: Point | null = null;
	let keyboardCommitTimer: ReturnType<typeof setTimeout> | null = null;

	function onKeyDown(event: KeyboardEvent): void {
		if (event.target !== event.currentTarget) return;
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
		const from = keyboardPosition ?? { ...effective };
		const moving: SolverShape = { ...shapeOfParticipant(participant), x: from.x, y: from.y };
		keyboardPosition = resolveMove(moving, { x: from.x + dx, y: from.y + dy }, obstacles());
		sync.participantOverlays.set(participant.id, keyboardPosition);
		if (keyboardCommitTimer !== null) clearTimeout(keyboardCommitTimer);
		keyboardCommitTimer = setTimeout(() => {
			if (keyboardPosition !== null) {
				void sync.commit(
					{ kind: 'move_participant', id: participant.id, location: keyboardPosition },
					participant.id
				);
			}
			keyboardPosition = null;
		}, 250);
	}
</script>

<!--
	Same rationale as ObjectFrame: movable canvas object, no fitting ARIA
	widget role. Verified by axe; logged in STYLE.md §9.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	class="avatar"
	role="group"
	aria-label={participant.name}
	class:dragging
	class:fake={participant.fake}
	style:--ring-width="{AVATAR_BORDER}px"
	style:width="{AVATAR_SIZE}px"
	style:height="{AVATAR_SIZE}px"
	style:transform="translate({effective.x}px, {effective.y}px)"
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
	onkeydown={onKeyDown}
	onfocus={() => {
		viewport.ensureVisible({ x: effective.x, y: effective.y, width: AVATAR_SIZE, height: AVATAR_SIZE });
	}}
	tabindex="0"
>
	<span class="face" aria-hidden="true">{participant.emoji}</span>
	<span class="name">{participant.name}</span>
</div>

<style>
	.avatar {
		position: absolute;
		left: 0;
		top: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		border-radius: 50%;
		background: var(--sticker); /* sticker border, same idiom as objects (UX-AV-1) */
		box-shadow: var(--shadow-1);
		cursor: grab;
		touch-action: none;
		user-select: none;
		z-index: 1000;
		outline: none;
	}
	.avatar:focus-within {
		box-shadow:
			0 0 0 var(--ring-width) var(--focus-ring),
			var(--shadow-1);
	}
	.avatar.dragging {
		cursor: grabbing;
	}
	.avatar.fake {
		filter: saturate(0.4);
	}
	.face {
		font-family: var(--font-emoji);
		font-size: 40px;
	}
	.name {
		font: var(--text-xs) var(--font-ui);
		color: var(--sticker-text);
		max-width: 84px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
