<script lang="ts">
	import Button from '$lib/ui/Button.svelte';
	import Emoji from '$lib/ui/Emoji.svelte';
	import { MIC_EMOJI, MUTED_EMOJI } from '$lib/model/emotes';
	import { stopPointer } from '$lib/ui/events';
	import { voicePreferences } from './voice.svelte';

	/**
	 * Turn one person down, for yourself only (UX-OBJ-16 × UX-AUDIO).
	 *
	 * Lives on the avatar because that is where the person is. A screen share's
	 * sound has had this since UX-OBJ-6; a voice had nothing, and DESIGN.md's
	 * open item blamed the asymmetry on a voice having "no position on the canvas
	 * yet". The voice does not — the SPEAKER does, and their avatar is the one
	 * thing in the room that already means this specific human.
	 *
	 * PER VIEWER. Nothing is broadcast, nobody else can tell, and the person
	 * themselves is never told: "three people have turned you down" is a fact
	 * that could only hurt. A host silencing someone for the whole room is a
	 * different mechanism on purpose (UX-STAGE-4, HostSlotControls) — that one
	 * decides who may speak, this one decides what reaches one pair of ears.
	 *
	 * The label carries the person's name, because a room can hold several of
	 * these and "Mute" alone would be ambiguous to anyone navigating by control
	 * (UX-A11Y-1).
	 *
	 * Both controls stop their own `pointerdown`. They live inside a DRAGGABLE
	 * avatar, so without it pressing either starts moving the person instead of
	 * adjusting them — the trap `ui/events.ts` exists for, and which cost this
	 * component a failing E2E before the helper was applied. The slider is the
	 * worse case of the two: a drag gesture is exactly how it is operated.
	 */

	interface Props {
		/** The person being listened to — never the viewer themselves. */
		id: string;
		name: string;
	}

	let { id, name }: Props = $props();

	const preference = $derived(voicePreferences.for(id));
</script>

<div class="voice">
	<Button
		shape="icon"
		pressed={preference.muted}
		label={preference.muted ? `Unmute ${name} for yourself` : `Mute ${name} for yourself`}
		title={preference.muted ? `Unmute ${name}` : `Mute ${name}`}
		onpointerdown={stopPointer}
		onclick={() => {
			voicePreferences.setMuted(id, !preference.muted);
		}}><Emoji glyph={preference.muted ? MUTED_EMOJI : MIC_EMOJI} size="16px" /></Button
	>
	<!--
		A native range input rather than a styled control: it is keyboard- and
		screen-reader-operable for free, and a volume slider is exactly the case
		where reimplementing that is all cost. Hidden label, because the button
		beside it already names the person.
	-->
	<label>
		<span class="sr-only">Volume for {name}</span>
		<input
			type="range"
			min="0"
			max="1"
			step="0.05"
			value={preference.volume}
			onpointerdown={stopPointer}
			disabled={preference.muted}
			oninput={(event) => {
				voicePreferences.setVolume(id, Number(event.currentTarget.value));
			}}
		/>
	</label>
</div>

<style>
	.voice {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}
	input {
		/* Narrow enough to sit under an avatar without widening its footprint,
		   which would change what the overlap solver thinks the person occupies. */
		width: 64px;
		accent-color: var(--accent);
	}
	input:disabled {
		opacity: 0.5;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
