<script lang="ts">
	import type { CanvasObject } from '$lib/model/types';
	import { MIC_EMOJI, MUTED_EMOJI } from '$lib/model/emotes';
	import Emoji from '$lib/ui/Emoji.svelte';

	/**
	 * A shared screen (UX-OBJ-6).
	 *
	 * Everything that makes this feel like an object — drag, resize, clip,
	 * z-order, fullscreen — comes from `ObjectFrame` and costs nothing here.
	 * AR-CANVAS-1 said it plainly before any of this existed: "a `<video>` bound
	 * to a MediaStream is just another node."
	 *
	 * The stream is passed DOWN rather than read from a store, for the same
	 * reason `AvatarTile`'s is: a MediaStream is not room state. It is not
	 * persisted, not versioned, and not the same for two people looking at the
	 * same room — only the fact that a share exists is shared.
	 */
	interface Props {
		object: CanvasObject;
		/** Undefined until the track arrives, which is a beat after the object. */
		stream?: MediaStream | undefined;
		/** Whose screen this is, for the accessible name. */
		ownerName?: string | undefined;
		/** Muted when it is your own screen, or you hear yourself twice. */
		isSelf?: boolean;
	}

	let { object, stream, ownerName, isSelf = false }: Props = $props();

	const label = $derived(
		ownerName === undefined ? 'A shared screen' : `${ownerName}’s shared screen`
	);

	/**
	 * The viewer's own choice, and the browser's (UX-OBJ-16).
	 *
	 * Per-viewer view state in exactly UX-CANVAS-4's sense: it mutates nothing
	 * for anyone else and is never synced. Component-local `$state` is the right
	 * home because the `{#each}` is keyed by `object.id`, so this lives exactly
	 * as long as the share does — and a share that ends and restarts should come
	 * back audible rather than remembering a mute nobody can see.
	 */
	let chosenMute = $state(false);
	/** The browser refused audible playback. See the effect below. */
	let blocked = $state(false);

	// A share with no sound must show no control. An inert mute button lies
	// about what the share carries — most shares carry no audio at all.
	const hasAudio = $derived(stream !== undefined && stream.getAudioTracks().length > 0);
	const muted = $derived(isSelf || chosenMute || blocked);

	const soundLabel = $derived(
		blocked
			? `Click to allow sound from ${label}`
			: chosenMute
				? `Unmute ${label}`
				: `Mute ${label}`
	);

	/** Clearing both is what makes the click itself the gesture the policy wants. */
	function allowSound(): void {
		if (blocked) {
			blocked = false;
			chosenMute = false;
		} else {
			chosenMute = !chosenMute;
		}
		void videoElement?.play().catch(() => undefined);
	}

	/**
	 * `srcObject` is a property, not an attribute, so it cannot be set in markup
	 * — writing `srcobject={...}` silently does nothing at all.
	 */
	let videoElement = $state<HTMLVideoElement | null>(null);
	$effect(() => {
		const element = videoElement;
		const current = stream;
		if (element === null) return;
		if (current === undefined) {
			element.srcObject = null;
			return;
		}
		element.srcObject = current;
		/*
		 * A rejected `play()` is a BLACK RECTANGLE, not a silent share.
		 *
		 * Once sound rides the same element as the picture, the browser's autoplay
		 * policy can refuse the whole thing — and the visible symptom is that the
		 * share does not appear at all, which reads as broken rather than as
		 * muted. So a refusal falls back to muted playback, which is always
		 * permitted, and surfaces itself through the mute control as an invitation
		 * to click.
		 *
		 * This may never fire in practice: Chrome exempts `MediaStream`-sourced
		 * elements from the policy, which is why the peer-voice `<audio>` loop has
		 * never misbehaved. Safari's exemption is narrower. It costs one boolean
		 * either way, because the control it surfaces through is one we need
		 * regardless.
		 */
		void element.play().catch(() => {
			blocked = true;
			void element.play().catch(() => undefined);
		});
	});
</script>

<div class="screenshare" data-object-type="screenshare" data-owner={object.id}>
	{#if stream !== undefined}
		<video bind:this={videoElement} class="video" autoplay playsinline {muted} aria-label={label}
		></video>
		<!-- Only when there is sound to control, and never on your own share —
		     you are already hearing the tab you are sharing, from the tab. -->
		{#if hasAudio && !isSelf}
			<button
				type="button"
				class="sound"
				class:blocked
				data-sound-control
				aria-label={soundLabel}
				title={soundLabel}
				aria-pressed={!muted}
				onclick={allowSound}
			>
				<Emoji glyph={muted ? MUTED_EMOJI : MIC_EMOJI} size="16px" />
				{#if blocked}<span class="hint">sound</span>{/if}
			</button>
		{/if}
	{:else}
		<!-- The object exists a beat before its track does — the mutation lands
		     over the store while the peer connection is still negotiating. Saying
		     so beats a black rectangle that looks like a broken share. -->
		<p class="waiting">{label} is starting…</p>
	{/if}
</div>

<style>
	.screenshare {
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		overflow: hidden;
		/* The positioning context for the sound control below. */
		position: relative;
		/* A screen is content to read, so it sits on a recessed ground rather than
		   the object's own surface colour — letterbox bars should read as frame,
		   not as part of what is being shared. */
		background: var(--bg-level-1);
	}

	.video {
		width: 100%;
		height: 100%;
		/* CONTAIN, never cover: cropping a shared screen hides the edges of what
		   somebody is trying to show, and the aspect ratio is theirs, not ours. */
		object-fit: contain;
		display: block;
	}

	.waiting {
		margin: 0;
		padding: var(--space-3);
		text-align: center;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}

	/*
	 * Sits ON the picture rather than in the frame's chrome row: it is a property
	 * of this content, and it must stay reachable in fullscreen (UX-CANVAS-4),
	 * where the frame's chrome is not rendered at all.
	 */
	.sound {
		position: absolute;
		bottom: var(--space-2);
		right: var(--space-2);
		display: flex;
		align-items: center;
		gap: var(--space-1);
		min-width: var(--target-min);
		min-height: var(--target-min);
		padding: 0 var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-full);
		background: var(--bg-level-4);
		color: var(--text);
		font-size: var(--text-xs);
		cursor: pointer;
	}
	.sound:focus-visible {
		outline: var(--ring-width) solid var(--focus-ring);
		outline-offset: var(--ring-offset);
	}
	/* Promoted when the BROWSER blocked playback: this is the one state where
	   the control is not a preference but the only way to see the share. */
	.sound.blocked {
		background: var(--accent);
		color: var(--accent-contrast);
		border-color: var(--accent);
	}
	.hint {
		white-space: nowrap;
	}
</style>
