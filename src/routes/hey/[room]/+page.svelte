<script lang="ts">
	import type { PageProps } from './$types';
	import type { StoredIdentity } from '$lib/model/types';
	import { loadIdentity } from '$lib/model/identity';
	import JoinPrompt from '$lib/ui/JoinPrompt.svelte';
	import Room from '$lib/canvas/Room.svelte';

	/**
	 * The identity gate. UX-ID-1: joining may be anonymous — no account
	 * required — but **a name is required**. So the room is not entered until
	 * there is one, rather than inventing `guest-473` and never asking.
	 *
	 * Room takes a non-nullable identity, which is why the gate lives out here:
	 * the component that needs an identity demands one instead of defending
	 * against its absence.
	 */
	let { data }: PageProps = $props();

	// ssr=false, so localStorage is available at init.
	let identity = $state<StoredIdentity | null>(loadIdentity());
</script>

<svelte:head>
	<title>{data.room} · mumble</title>
</svelte:head>

{#if identity === null}
	<JoinPrompt
		onjoin={(joined: StoredIdentity) => {
			identity = joined;
		}}
	/>
{:else}
	<Room room={data.room} {identity} />
{/if}
