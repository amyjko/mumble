<script lang="ts">
	import type { PageProps } from './$types';
	import type { StoredIdentity } from '$lib/model/types';
	import { loadIdentity } from '$lib/model/identity';
	import JoinPrompt from '$lib/ui/JoinPrompt.svelte';
	import { joinRoom } from '$lib/auth/membership.svelte';
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

	/**
	 * Membership resolves asynchronously: an anonymous session is created, then
	 * the join RPC reports whether this identity is a host (AR-CTRL-7).
	 *
	 * The canvas renders IMMEDIATELY on the stub rather than waiting — a room
	 * that blanks until a network round trip completes is worse than one whose
	 * host controls appear a moment late, and a guest (the common case) has no
	 * host controls to wait for.
	 */
	let isHost = $state(false);
	$effect(() => {
		const room = data.room;
		void joinRoom(room).then((membership) => {
			isHost = membership.isHost;
		});
	});
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
	<Room room={data.room} {identity} {isHost} />
{/if}
