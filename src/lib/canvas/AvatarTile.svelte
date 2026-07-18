<script lang="ts">
	import type { Participant, Point, SolverShape } from '$lib/model/types';
	import type { RoomStore } from '$lib/store/room-store';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import type { Viewport } from './viewport.svelte';
	import { resolveMove } from './geometry';
	import { AVATAR_SIZE, AVATAR_BORDER, shapeOfParticipant } from '$lib/store/memory-store.svelte';
	import { AVATAR_Z } from './layers';

	interface Props {
		participant: Participant;
		store: RoomStore;
		sync: SyncClient;
		viewport: Viewport;
		obstacles: () => SolverShape[];
		isSelf: boolean;
	}

	let { participant, store, sync, viewport, obstacles, isSelf }: Props = $props();

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

	// Transient reactions (UX-AV-4): the current emote for this participant,
	// cleared after the animation. The nonce re-triggers repeats.
	const EMOTE_EMOJI: Record<string, string> = {
		tada: '🎉', bounce: '⬆️', bored: '😴', spin: '🪙', heart: '❤️', laugh: '😂'
	};
	let activeEmote = $state<string | null>(null);
	let emoteTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		const e = sync.emotes.get(participant.id);
		if (e === undefined) return;
		void e.nonce; // depend on the nonce so repeats re-fire
		activeEmote = e.emote;
		if (emoteTimer !== null) clearTimeout(emoteTimer);
		emoteTimer = setTimeout(() => {
			activeEmote = null;
		}, 1600);
	});

	let menuOpen = $state(false);
	function react(emote: 'tada' | 'bounce' | 'bored' | 'spin' | 'heart' | 'laugh'): void {
		sync.react(participant.id, emote);
		menuOpen = false;
	}
	function toggleHand(): void {
		void sync.commit({ kind: 'set_hand', id: participant.id, raised: !participant.raised_hand });
	}
	function toggleAway(): void {
		void sync.commit({ kind: 'set_away', id: participant.id, away: !participant.away });
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
	style:z-index={AVATAR_Z}
	role="group"
	aria-label={participant.name}
	class:dragging
	class:fake={participant.fake}
	class:away={participant.away}
	class:raised={participant.raised_hand}
	class:bounce={activeEmote === 'bounce'}
	class:spin={activeEmote === 'spin'}
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
	{#if participant.raised_hand}
		<span class="hand" aria-label="hand raised">✋</span>
	{/if}
	{#if activeEmote !== null}
		{#key sync.emotes.get(participant.id)?.nonce}
			<span class="float" aria-hidden="true">{EMOTE_EMOJI[activeEmote] ?? '👍'}</span>
		{/key}
	{/if}
	{#if isSelf}
		<div class="emote-menu">
			<button
				class="emote-trigger"
				aria-expanded={menuOpen}
				aria-label="Emote"
				onpointerdown={(e) => {
					e.stopPropagation();
				}}
				onclick={() => {
					menuOpen = !menuOpen;
				}}>☺</button
			>
			{#if menuOpen}
				<div class="emote-pop">
					{#each ['tada', 'heart', 'laugh', 'bounce', 'bored', 'spin'] as const as e (e)}
						<button
							aria-label="React {e}"
							onpointerdown={(ev) => {
								ev.stopPropagation();
							}}
							onclick={() => {
								react(e);
							}}>{EMOTE_EMOJI[e]}</button
						>
					{/each}
					<button
						aria-pressed={participant.raised_hand}
						onpointerdown={(ev) => {
							ev.stopPropagation();
						}}
						onclick={toggleHand}>✋ hand</button
					>
					<button
						aria-pressed={participant.away}
						onpointerdown={(ev) => {
							ev.stopPropagation();
						}}
						onclick={toggleAway}>💤 away</button
					>
				</div>
			{/if}
		</div>
	{/if}
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
	.avatar.away {
		filter: grayscale(1) opacity(0.6);
	}
	.avatar.raised {
		box-shadow:
			0 0 0 3px var(--accent),
			0 0 16px var(--accent);
	}
	/* Bounce/spin use the standalone translate/rotate properties, which compose
	   with the positioning transform rather than overriding it. */
	.avatar.bounce {
		animation: emote-bounce 0.4s ease 2;
	}
	.avatar.spin {
		animation: emote-spin 0.7s linear 1;
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
	.hand {
		position: absolute;
		top: calc(-1 * var(--space-3));
		right: calc(-1 * var(--space-1));
		font-size: 20px;
	}
	.float {
		position: absolute;
		top: -8px;
		font-size: 28px;
		pointer-events: none;
		animation: emote-float 1.6s ease-out forwards;
	}
	@keyframes emote-float {
		0% {
			transform: translateY(0) scale(0.6);
			opacity: 0;
		}
		20% {
			opacity: 1;
			transform: translateY(-10px) scale(1.1);
		}
		100% {
			transform: translateY(-70px) scale(1);
			opacity: 0;
		}
	}
	.emote-menu {
		position: absolute;
		bottom: calc(-1 * var(--space-2));
		right: calc(-1 * var(--space-2));
	}
	.emote-trigger {
		width: var(--target-min);
		height: var(--target-min);
		border-radius: var(--radius-full);
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
		font-size: var(--text-md);
		line-height: 1;
		opacity: 0;
		transition: opacity 120ms;
	}
	.avatar:hover .emote-trigger,
	.avatar:focus-within .emote-trigger {
		opacity: 1;
	}
	.emote-pop {
		position: absolute;
		bottom: 100%;
		right: 0;
		display: flex;
		flex-wrap: wrap;
		width: 132px;
		gap: var(--space-1);
		padding: var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface);
		box-shadow: var(--shadow-2);
	}
	.emote-pop button {
		min-height: var(--target-min);
		padding: 0 var(--space-1);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		color: var(--text);
		font-size: var(--text-sm);
		cursor: pointer;
	}
	.emote-pop button[aria-pressed='true'] {
		background: var(--accent);
		color: var(--accent-contrast);
		border-color: var(--accent);
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
