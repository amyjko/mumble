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
	import { SupabaseRoomStore } from '$lib/store/supabase-store.svelte';
	import { deferredWork } from '$lib/canvas/deferred.svelte';

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

	/**
	 * The AUTHENTICATED user id, held separately from the identity.
	 *
	 * These are two different things and conflating them cost a debugging
	 * session: the id is who the SERVER says you are (it reads the verified JWT
	 * and takes no notice of the browser's claim), while name and emoji are the
	 * profile you chose. A visitor with no roamed profile kept whatever id
	 * localStorage held — usually an older anonymous session's — so every
	 * self-checked mutation came back "You can only take your own slot" while
	 * the ones that do not check self succeeded. Against the stub this was
	 * invisible, because nothing ever disagreed with the browser.
	 *
	 * Kept apart rather than folded into `identity` so that adopting the id
	 * cannot accidentally manufacture a nameless identity and dismiss the join
	 * prompt, which is exactly what folding them together did (UX-ID-1 requires
	 * a name before entry).
	 */
	let authId = $state('');

	/**
	 * The store, built ONCE PER ROOM and injected into the canvas.
	 *
	 * Keyed on the room and nothing else. It deliberately does not read
	 * `identity` or `isHost`: taking those made it a `$derived` on identity, so
	 * the store and its Realtime channel were torn down and rebuilt every time
	 * anonymous sign-in, the join RPC, or a roamed profile resolved. The actor
	 * is set afterwards instead (see below), which is why `setActor` exists.
	 *
	 * Still derived rather than constructed once for the component: renaming a
	 * room NAVIGATES (UX-ROOM-10), and SvelteKit reuses this component across
	 * that navigation, so a store built once would keep talking to the old room.
	 */
	/**
	 * The store, built ONCE PER ROOM and injected into the canvas.
	 *
	 * An EFFECT, not a `$derived`. Constructing this opens a Realtime channel
	 * and kicks off a hydrate that writes `state` — side effects, and a derived
	 * must be pure. Built as a derived it wrote state the derived itself owned,
	 * so every hydrate invalidated the derived, which built another store, which
	 * hydrated: effect_update_depth_exceeded, the page's reactivity dead, and
	 * every broadcast after it silently ignored. It surfaced in the SECOND tab
	 * rather than the first, because the first usually finishes hydrating before
	 * anyone looks — which is exactly the page-wiring bug class room.e2e exists
	 * to catch.
	 *
	 * Keyed on the room and nothing else. It deliberately does not read
	 * `identity` or `isHost`: taking those rebuilt the store, and its channel,
	 * every time anonymous sign-in, the join RPC, or a roamed profile resolved.
	 * The actor is set afterwards instead, which is why `setActor` exists.
	 *
	 * Rebuilt when the room changes because renaming NAVIGATES (UX-ROOM-10) and
	 * SvelteKit reuses this component across that navigation; the cleanup closes
	 * the old room's channel rather than leaving it open for a room nobody is
	 * looking at.
	 */
	let store = $state<SupabaseRoomStore | null>(null);
	// `$effect.pre`, not `$effect`: a component's own effects run AFTER its
	// children's, so a plain effect here would publish the store and set its
	// actor only after Room's join effect had already committed against a store
	// that did not know who was acting.
	$effect.pre(() => {
		const active = new SupabaseRoomStore(data.roomId, data.room);
		// The actor BEFORE the store is published, untracked so this effect still
		// depends only on the room. Room's join effect commits the moment it
		// mounts, and a store with no actor skips the optimistic local apply —
		// so the participant existed on the server and not in local state, and
		// the next click ("Turn camera on") was refused by the client's own rule
		// engine with "Unknown participant" and never reached the server at all.
		active.setActor(untrack(() => authId), untrack(() => isHost));
		store = active;
		return () => {
			active.dispose();
		};
	});

	/**
	 * The actor, once it is known. Before this the store commits without a local
	 * optimistic apply and lets the server be the sole judge — correct, just
	 * less responsive for the moment it lasts.
	 */
	/**
	 * Mirror in-flight writes onto the document, beside `data-hydrated`.
	 *
	 * Same reasoning as that attribute: tests need one honest signal for "the
	 * app has finished doing the thing", and inventing a per-test proxy for it
	 * is how fixed sleeps get written. This one says "no commit is in flight",
	 * which is what a test waiting on a write actually means.
	 */
	$effect(() => {
		// Scheduled-but-unissued commits count too: during a debounce window the
		// store has nothing in flight, so watching it alone would report
		// "settled" for a write that has not been sent yet.
		const busy = (store?.pending ?? 0) + deferredWork.outstanding;
		document.documentElement.dataset['syncing'] = busy > 0 ? 'true' : 'false';
	});

	// Also `.pre`, and for the same ordering reason: the roamed profile lands
	// after mount, and Room re-commits when it does.
	$effect.pre(() => {
		// `authId` ONLY, never the localStorage identity: RLS authorizes the
		// Realtime channel and every read against the JWT subject, so a
		// browser-supplied id is not merely stale, it cannot authorize anything.
		// A second tab that started from one subscribed as a non-member.
		store?.setActor(authId, isHost);
	});

	$effect(() => {
		const room = data.room;
		// `identity` is passed in so a name chosen in THIS browser seeds the
		// stored profile on first sign-in, rather than being replaced by it.
		void joinRoom(room, untrack(() => identity)).then((membership) => {
			isHost = membership.isHost;
			const current = untrack(() => identity);
			authId = membership.userId ?? '';

			// The stored profile WINS (UX-ID-6): it is the roaming copy, and the
			// browser you happen to be at is the incidental thing.
			const profile = membership.profile;
			const next =
				profile !== null
					? { id: authId, name: profile.name, emoji: profile.emoji }
					: // No roamed profile: keep the local details and correct only
						// the id. Deliberately NOT synthesised when there is no local
						// identity either — a blank name would dismiss the join prompt
						// and put a nameless avatar in the room.
						current === null
						? null
						: { ...current, id: authId };

			if (next === null) return;
			identity = next;
			// Mirrored back to localStorage so an offline reload still knows who
			// you are.
			saveIdentity(next);
		});
	});
</script>

<svelte:head>
	<title>{data.room} · mumble</title>
</svelte:head>

{#if identity === null}
	<JoinPrompt
		onjoin={(joined: StoredIdentity) => {
			// The id the server will check, not the one the prompt invented.
			identity = { ...joined, id: authId !== '' ? authId : joined.id };
			// Seed the profile HERE too, not only in the join effect above. That
			// effect runs on mount, before a first-time visitor has answered this
			// prompt — so it sees no local identity, seeds nothing, and the name
			// they just chose would never leave this browser.
			void saveMyProfile(supabaseBrowser(), { name: joined.name, emoji: joined.emoji });
		}}
	/>
{:else if store !== null && store.ready}
	<!--
		Waits for the session, deliberately.

		The canvas used to render immediately, on the reasoning that a room which
		blanks for a round trip is worse than one whose host controls arrive late.
		That was true of the stub, where the actor was whatever the browser said.
		It is not true now: Room commits `upsert_participant` the moment it
		mounts, so rendering before the authenticated id arrived put a
		participant in the room under the localStorage id and then ANOTHER under
		the real one — two avatars for one person, "Tester" beside "Tester (you)",
		and every count, announcement and auto-fit downstream of it wrong.

		`store.ready` means the room has been READ once, which also implies the
		session resolved — the store cannot read before it knows who is asking,
		since RLS authorizes on the JWT subject. So this waits on the join round
		trip plus one read.
	-->
	<Room room={data.room} {identity} {isHost} {store} />
{/if}
