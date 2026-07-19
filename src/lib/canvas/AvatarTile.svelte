<script lang="ts">
	import type { Participant, Point, SolverShape, Transform } from '$lib/model/types';
	import type { RoomStore } from '$lib/store/room-store';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import type { Viewport } from './viewport.svelte';
	import { resolveDrag } from './geometry';
	import { AVATAR_BORDER, shapeOfParticipant } from '$lib/store/memory-store.svelte';
	import { AVATAR_Z } from './layers';
	import { EMOTE_EMOJI, HAND_EMOJI, AWAY_EMOJI, VIDEO_EMOJI, MIC_EMOJI, MUTED_EMOJI } from '$lib/model/emotes';
	import Emoji from '$lib/ui/Emoji.svelte';
	import Button from '$lib/ui/Button.svelte';
	import TransformHandles from './TransformHandles.svelte';
	import { clipPathCss, nextClip } from '$lib/model/clip';
	import { resizeTransform, rotationForPointer, snapRotation, type ResizeHandle } from './resize';
	import { hint, SNAP_HINT } from './hint.svelte';
	import { stopPointer } from '$lib/ui/events';

	/** Avatars stay recognisably people: smaller than this and the face is gone. */
	const MIN_AVATAR = 56;

	/**
	 * Raise-hand is queue membership now (UX-AV-6), not a stored flag — so
	 * there is nothing to keep in sync when a handoff promotes someone.
	 */
	interface Props {
		participant: Participant;
		store: RoomStore;
		sync: SyncClient;
		viewport: Viewport;
		obstacles: () => SolverShape[];
		isSelf: boolean;
	}

	let { participant, store, sync, viewport, obstacles, isSelf }: Props = $props();

	/** UX-AV-6: the raised hand IS the queue entry. */
	const queued = $derived(store.state.queue.includes(participant.id));
	/** UX-STAGE-9: who holds what is explicit, and shown on the avatar. */
	const hasVideo = $derived(store.state.video_holders.includes(participant.id));
	const hasAudio = $derived(store.state.audio_holders.includes(participant.id));

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
		lastResolved = resolveDrag(moving, desired, obstacles());
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

	/**
	 * Every reaction currently floating above this participant (UX-AV-4). The
	 * client keeps a list, so a burst of clicks shows a burst of emoji instead
	 * of only the most recent one; each expires on its own timer.
	 */
	const reactions = $derived(sync.reactionsFor(participant.id));

	/** Whole-body animations still key off the most recent reaction. */
	const latest = $derived(reactions.at(-1)?.emote ?? null);

	/**
	 * Fan the floats out horizontally so simultaneous reactions are all
	 * legible instead of stacking into one illegible pile. Deterministic from
	 * the reaction key, since Math.random is unavailable in this codebase's
	 * test environment and a stable offset is easier to reason about anyway.
	 */
	function driftFor(key: number): number {
		const spread = [0, -22, 22, -12, 12, -30, 30];
		return spread[key % spread.length] ?? 0;
	}


	/**
	 * Resize / rotate / reshape, exactly as objects have (UX-AV-1) — an avatar
	 * is a canvas object, so there was no principled reason it alone was pinned
	 * to a fixed circle. Self-only: the store rejects changing someone else's
	 * avatar, the same rule that governs emotes (UX-AV-7).
	 */
	const clipPath = $derived(clipPathCss(participant.clip));
	const outerRadius = $derived(participant.clip.shape === 'circle' ? '50%' : participant.clip.shape === 'rounded' ? `${String(participant.clip.radius)}px` : '0');

	let handleKind = $state<ResizeHandle | 'rotate' | null>(null);
	let handleStart: Transform = { x: 0, y: 0, width: 0, height: 0, rotation: 0, z: 0 };
	let handlePointer: Point = { x: 0, y: 0 };
	let handleLast: Transform = handleStart;

	function onHandleMove(event: PointerEvent): void {
		if (handleKind === null) return;
		const world = viewport.toWorld({ x: event.clientX, y: event.clientY });
		if (handleKind === 'rotate') {
			const center = { x: handleStart.x + handleStart.width / 2, y: handleStart.y + handleStart.height / 2 };
			handleLast = { ...handleStart, rotation: snapRotation(rotationForPointer(center, world), { precise: event.shiftKey }) };
		} else {
			handleLast = resizeTransform(
				handleStart,
				handleKind,
				world.x - handlePointer.x,
				world.y - handlePointer.y,
				{ precise: event.shiftKey },
				{ width: MIN_AVATAR, height: MIN_AVATAR }
			);
		}
		liveTransform = handleLast;
	}

	function onHandleUp(): void {
		window.removeEventListener('pointermove', onHandleMove);
		hint.clear();
		if (handleKind === null) return;
		handleKind = null;
		void sync.commit({
			kind: 'size_participant',
			id: participant.id,
			location: { x: handleLast.x, y: handleLast.y },
			size: { width: handleLast.width, height: handleLast.height },
			rotation: handleLast.rotation
		});
		liveTransform = null;
	}

	function onHandleDown(kind: ResizeHandle | 'rotate', event: PointerEvent): void {
		event.stopPropagation();
		handleKind = kind;
		handleStart = {
			x: effective.x,
			y: effective.y,
			width: participant.size.width,
			height: participant.size.height,
			rotation: participant.rotation,
			z: 0
		};
		handleLast = handleStart;
		handlePointer = viewport.toWorld({ x: event.clientX, y: event.clientY });
		hint.show(SNAP_HINT);
		window.addEventListener('pointermove', onHandleMove);
		window.addEventListener('pointerup', onHandleUp, { once: true });
	}

	/** In-flight resize preview; falls back to committed state between gestures. */
	let liveTransform = $state<Transform | null>(null);
	const shown = $derived({
		x: liveTransform?.x ?? effective.x,
		y: liveTransform?.y ?? effective.y,
		width: liveTransform?.width ?? participant.size.width,
		height: liveTransform?.height ?? participant.size.height,
		rotation: liveTransform?.rotation ?? participant.rotation
	});

	function cycleAvatarShape(): void {
		void sync.commit({ kind: 'set_participant_clip', id: participant.id, clip: nextClip(participant.clip) });
	}

	/** Keyboard movement (UX-A11Y-2): same solver, debounced commit. */
	let keyboardPosition: Point | null = null;
	let keyboardCommitTimer: ReturnType<typeof setTimeout> | null = null;

	function onKeyDown(event: KeyboardEvent): void {
		if (event.target !== event.currentTarget) return;

		/*
		 * Keyboard parity with objects (UX-A11Y-2): "everything the pointer does
		 * can be done from the keyboard". Avatars gained pointer resize, rotate
		 * and reshape when they became canvas objects, and the keyboard was left
		 * behind — so those three were pointer-only, which is exactly the gap
		 * the requirement forbids. Same keys as ObjectFrame, so there is one
		 * vocabulary to learn rather than two.
		 */
		if (isSelf && event.altKey && event.key.startsWith('Arrow')) {
			const g = 16;
			const min = MIN_AVATAR;
			const size = {
				width:
					event.key === 'ArrowRight'
						? participant.size.width + g
						: event.key === 'ArrowLeft'
							? Math.max(min, participant.size.width - g)
							: participant.size.width,
				height:
					event.key === 'ArrowDown'
						? participant.size.height + g
						: event.key === 'ArrowUp'
							? Math.max(min, participant.size.height - g)
							: participant.size.height
			};
			event.preventDefault();
			void sync.commit({
				kind: 'size_participant',
				id: participant.id,
				location: { x: effective.x, y: effective.y },
				size,
				rotation: participant.rotation
			});
			return;
		}
		if (isSelf && (event.key === '[' || event.key === ']')) {
			event.preventDefault();
			const delta = event.key === '[' ? -15 : 15;
			void sync.commit({
				kind: 'size_participant',
				id: participant.id,
				location: { x: effective.x, y: effective.y },
				size: participant.size,
				rotation: snapRotation(participant.rotation + delta, { precise: false })
			});
			return;
		}
		if (isSelf && (event.key === 'c' || event.key === 'C')) {
			event.preventDefault();
			cycleAvatarShape();
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
		const from = keyboardPosition ?? { ...effective };
		const moving: SolverShape = { ...shapeOfParticipant(participant), x: from.x, y: from.y };
		keyboardPosition = resolveDrag(moving, { x: from.x + dx, y: from.y + dy }, obstacles());
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
	widget role. Verified by axe; logged in STYLE.md §10.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	class="avatar"
	style:z-index={AVATAR_Z}
	role="group"
	aria-label={isSelf ? `${participant.name} (you)` : participant.name}
	class:dragging
	class:fake={participant.fake}
	class:away={participant.away}
	class:self={isSelf}
	class:raised={queued}
	class:bounce={latest === 'bounce'}
	class:spin={latest === 'spin'}
	class:bored={latest === 'bored'}
	style:--ring-width="{AVATAR_BORDER}px"
	style:width="{shown.width}px"
	style:height="{shown.height}px"
	style:transform="translate({shown.x}px, {shown.y}px) rotate({shown.rotation}deg)"
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
	onkeydown={onKeyDown}
	onfocus={() => {
		viewport.ensureVisible({ x: shown.x, y: shown.y, width: shown.width, height: shown.height });
	}}
	tabindex="0"
>
	<!-- Clip on an inner layer, never on the tile: clip-path clips hit-testing
	     for descendants, which would swallow the handles (the trap that
	     ObjectFrame already hit). -->
	<div class="skin" style:border-radius={outerRadius} style:clip-path={clipPath ?? 'none'}></div>
	<span class="face"><Emoji glyph={participant.emoji} size="40px" /></span>
	<!-- The name floats BELOW the avatar rather than inside it: within a round
	     tile it had to be clamped to 84px and was clipped by the circle. -->
	<span class="name">{participant.name}</span>

	<!-- Persistent states (UX-AV-5) are room-visible signals, so they are big
	     and centered above the head rather than small corner marks. -->
	{#if queued}
		<span class="badge hand"><Emoji glyph={HAND_EMOJI} label="hand raised" /></span>
	{/if}
	{#if hasVideo || hasAudio}
		<!-- UX-STAGE-9: "each participant's A/V object is annotated with whether
		     they hold a video slot, an audio slot, or neither". -->
		<span class="badge slots">
			{#if hasVideo}<Emoji glyph={VIDEO_EMOJI} label="holds a video slot" />{/if}
			{#if hasAudio}<Emoji glyph={MIC_EMOJI} label="holds an audio slot" />{/if}
			{#if participant.muted}<Emoji glyph={MUTED_EMOJI} label="muted" />{/if}
		</span>
	{/if}
	{#if participant.away}
		<span class="badge away-badge"><Emoji glyph={AWAY_EMOJI} label="stepped away" /></span>
	{/if}

	{#if isSelf}
		<TransformHandles {onHandleDown} subject="avatar" />
		<span class="shape-control">
			<Button
				variant="chrome"
				shape="icon"
				label="Change avatar shape (currently {participant.clip.shape})"
				onpointerdown={stopPointer}
				onclick={cycleAvatarShape}>◇</Button
			>
		</span>
	{/if}

	{#each reactions as reaction (reaction.key)}
		<span class="float" style:--drift="{driftFor(reaction.key)}px">
			<Emoji glyph={EMOTE_EMOJI[reaction.emote]} size="32px" />
		</span>
	{/each}
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
		gap: var(--space-0);

		/* `move`, not `grab`: the canvas beneath uses grab for panning, and
		   identical cursors gave no cue which gesture a press would start. */
		cursor: move;
		touch-action: none;
		user-select: none;
		outline: none;
	}
	.skin {
		position: absolute;
		inset: 0;
		background: var(--sticker); /* sticker border, same idiom as objects (UX-AV-1) */
		box-shadow: var(--shadow-1);
		pointer-events: none;
	}
	.shape-control {
		position: absolute;
		bottom: calc(-1 * var(--space-3));
		left: calc(-1 * var(--space-3));
		opacity: 0;
		transition: opacity 120ms;
	}
	.avatar:hover :global(.resize),
	.avatar:focus-within :global(.resize),
	.avatar:hover :global(.rotate),
	.avatar:focus-within :global(.rotate),
	.avatar:hover .shape-control,
	.avatar:focus-within .shape-control {
		opacity: 1;
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
	/* UX-AV-5's "greyscale blur state". The blur was missing, so stepped-away
	   read as merely desaturated rather than absent. Applied to the face only,
	   so the away badge announcing the state stays legible. */
	.avatar.away .face {
		filter: grayscale(1) opacity(0.6) blur(1.5px);
	}
	/*
	 * UX-AV-5: raise-hand "stretches the A/V slot's corner like a hand being
	 * raised and makes the corner glow". It was a plain ring around the whole
	 * tile — the glow without the gesture. The skin's top-left corner now
	 * elongates while the glow stays.
	 */
	.avatar.raised .skin {
		border-top-left-radius: 4px;
		scale: 1.06;
		transform-origin: top left;
		box-shadow:
			0 0 0 3px var(--accent),
			0 0 18px var(--accent);
		transition:
			scale 180ms ease,
			border-top-left-radius 180ms ease;
	}
	/* Bounce/spin use the standalone translate/rotate properties, which compose
	   with the positioning transform rather than overriding it. */
	.avatar.bounce {
		animation: emote-bounce 0.4s ease 2;
	}
	.avatar.spin {
		animation: emote-spin 0.7s linear 1;
	}
	/* UX-AV-4's "laying down" — it had a floating glyph but no animation, so
	   boredom was the one emote with nothing to see. Uses the standalone
	   `rotate`/`translate` properties like its siblings, so it composes with
	   the positioning transform instead of overwriting it. */
	.avatar.bored {
		animation: emote-bored 1.4s ease-in-out 1;
	}
	@keyframes emote-bored {
		0% {
			rotate: 0deg;
			translate: 0 0;
		}
		25% {
			rotate: -78deg;
			translate: -6px 10px;
		}
		75% {
			rotate: -78deg;
			translate: -6px 10px;
		}
		100% {
			rotate: 0deg;
			translate: 0 0;
		}
	}
	@keyframes emote-bounce {
		0%,
		100% {
			translate: 0 0;
		}
		50% {
			translate: 0 -14px;
		}
	}
	@keyframes emote-spin {
		from {
			rotate: 0deg;
		}
		to {
			rotate: 360deg;
		}
	}
	/*
	 * POSITIONED, so it paints above .skin. The sticker layer is absolutely
	 * positioned and therefore paints above static siblings regardless of DOM
	 * order — it was covering the face entirely, leaving a blank white circle.
	 *
	 * This hid from three separate DOM probes: the element exists, has a box,
	 * and even answers elementFromPoint, because .skin sets pointer-events:
	 * none — so hit-testing skips the very layer that was painting over it.
	 * Only a screenshot showed it.
	 */
	.face {
		position: relative;
		display: inline-flex;
	}
	/* Slot badges sit BELOW the tile so they never collide with the raised-hand
	   badge above it. */
	.badge.slots {
		bottom: auto;
		top: 100%;
		margin-top: var(--space-4);
		font-size: 18px;
		display: flex;
		gap: var(--space-0);
	}
	.badge {
		position: absolute;
		bottom: 100%;
		left: 50%;
		translate: -50% 0;
		margin-bottom: calc(-1 * var(--space-1));
		font-size: 34px;
		line-height: 1;
		pointer-events: none;
	}
	.float {
		position: absolute;
		bottom: 60%;
		left: 50%;
		pointer-events: none;
		animation: emote-float 1.6s ease-out forwards;
	}
	@keyframes emote-float {
		0% {
			transform: translate(-50%, 0) scale(0.6);
			opacity: 0;
		}
		20% {
			opacity: 1;
			transform: translate(calc(-50% + var(--drift) * 0.4), -10px) scale(1.1);
		}
		100% {
			transform: translate(calc(-50% + var(--drift)), -70px) scale(1);
			opacity: 0;
		}
	}
	/* Which avatar is yours used to be implied by the emote launcher hanging
	   off it. The launcher now lives in the bottom bar, so mark it explicitly
	   — and not by color alone (the accessible name says "(you)" too). */
	.avatar.self .name {
		font-weight: 600;
	}
	.avatar.self .name::after {
		content: ' (you)';
		color: var(--text-muted);
		font-weight: 400;
	}
	.name {
		/* Outside the tile, so the round clip can't cut it and it needs no
		   width clamp. Minimum readable size, same UI font as everything else —
		   it used the `font:` shorthand before, which reset line-height. */
		position: absolute;
		top: 100%;
		margin-top: var(--space-1);
		font-family: var(--font-ui);
		font-size: var(--text-xs);
		line-height: 1.2;
		color: var(--text);
		white-space: nowrap;
		pointer-events: none;
		text-shadow:
			0 1px 2px var(--surface),
			0 -1px 2px var(--surface),
			1px 0 2px var(--surface),
			-1px 0 2px var(--surface);
	}
</style>
