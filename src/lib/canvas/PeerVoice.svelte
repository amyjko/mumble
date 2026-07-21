<script lang="ts">
	import { voicePreferences } from './voice.svelte';

	/**
	 * One remote person's voice (UX-OBJ-16 × UX-AUDIO).
	 *
	 * Replaces a bare `<audio use:attachStream autoplay>` in Room.svelte that had
	 * no volume, no mute, and — the part that actually mattered — no handling for
	 * a refused `play()`. ScreenshareObject already did all three for a share's
	 * sound and its comment pointed straight at this loop as the thing it did
	 * better.
	 *
	 * Still OFF-CANVAS and unstyled. A voice has no position (proximity audio is
	 * Later, UX-AUDIO-1), so this renders nothing; the CONTROLS live on the
	 * person's avatar, which is the thing on the canvas that means "this human".
	 *
	 * One element per peer rather than a mixer, which keeps per-peer volume a
	 * property of an element rather than a gain graph this project does not have
	 * yet. The mixing plane arrives with proximity audio and replaces this, not
	 * the avatars.
	 */

	interface Props {
		peer: string;
		stream: MediaStream;
	}

	let { peer, stream }: Props = $props();

	let element = $state<HTMLAudioElement | null>(null);

	const preference = $derived(voicePreferences.for(peer));

	/**
	 * `srcObject` is a property, not an attribute, so it cannot be set in markup
	 * — writing `srcobject={...}` silently does nothing at all.
	 */
	$effect(() => {
		const node = element;
		const current = stream;
		if (node === null) return;
		node.srcObject = current;
		return () => {
			node.srcObject = null;
		};
	});

	/**
	 * Volume and mute, applied as PROPERTIES for the same reason.
	 *
	 * Separate from the attach effect so changing the volume does not re-assign
	 * `srcObject` — which restarts playback, and would make dragging a volume
	 * slider stutter the very voice it is adjusting.
	 */
	$effect(() => {
		const node = element;
		if (node === null) return;
		node.volume = preference.volume;
		node.muted = preference.muted;
	});

	/**
	 * Start playing, and notice when the browser refuses.
	 *
	 * Depends on `voicePreferences.blocked` so that clicking "allow sound"
	 * re-runs this and retries every voice at once — the flag is per document,
	 * because the autoplay policy is.
	 *
	 * A refusal here is SILENCE WITH NO EXPLANATION, which is the worst failure
	 * mode available: the room looks like it is working and nobody can hear
	 * anyone. Reporting it is what lets the room offer a way out.
	 */
	$effect(() => {
		const node = element;
		if (node === null) return;
		// Read so this re-runs when the viewer allows sound.
		void voicePreferences.blocked;
		void node.play().catch(() => {
			voicePreferences.reportBlocked();
		});
	});
</script>

<!--
	`autoplay` is kept as well as the explicit `play()`: the attribute covers the
	common case without waiting for an effect, and the call is what produces a
	rejection we can see.
-->
<audio bind:this={element} autoplay></audio>
