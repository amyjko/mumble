<script lang="ts">
	import { untrack } from 'svelte';
	import type { PageProps } from './$types';
	import type { StoredIdentity } from '$lib/model/types';
	import { loadIdentity, saveIdentity } from '$lib/model/identity';
	import JoinPrompt from '$lib/ui/JoinPrompt.svelte';
	import { joinRoom } from '$lib/auth/membership.svelte';
	import { saveMyProfile } from '$lib/auth/profile';
	import { supabaseBrowser } from '$lib/auth/browser-client';
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
		// `identity` is passed in so a name chosen in THIS browser seeds the
		// stored profile on first sign-in, rather than being replaced by it.
		void joinRoom(room, untrack(() => identity)).then((membership) => {
			isHost = membership.isHost;
			if (membership.profile === null) return;
			// The stored profile WINS (UX-ID-6): it is the roaming copy, and the
			// browser you happen to be at is the incidental thing. Mirrored back
			// to localStorage so an offline reload still knows who you are.
			const roamed = {
				id: membership.userId ?? identity?.id ?? '',
				name: membership.profile.name,
				emoji: membership.profile.emoji
			};
			identity = roamed;
			saveIdentity(roamed);
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
			// Seed the profile HERE too, not only in the join effect above. That
			// effect runs on mount, before a first-time visitor has answered this
			// prompt — so it sees no local identity, seeds nothing, and the name
			// they just chose would never leave this browser.
			void saveMyProfile(supabaseBrowser(), { name: joined.name, emoji: joined.emoji });
		}}
	/>
{:else}
	<Room room={data.room} {identity} {isHost} />
{/if}
