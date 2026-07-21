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
	import WaitingRoom from '$lib/ui/WaitingRoom.svelte';
	import OutOfTime from '$lib/ui/OutOfTime.svelte';
	import { SupabaseRoomStore } from '$lib/store/supabase-store.svelte';
	import { deferredWork } from '$lib/canvas/deferred.svelte';
	import { roomBudget } from '$lib/canvas/budget.svelte';
	import { z } from 'zod';

	/**
	 * The slice of the heartbeat's reply this page reads.
	 *
	 * `.nullable()`, because the server returns null when the ledger cannot be
	 * read — it fails open rather than guessing, and so does the readout.
	 */
	const beatBudgetSchema = z.object({
		budget: z
			.object({ usedSeconds: z.number(), capSeconds: z.number(), resetsAt: z.string() })
			.nullable()
	});

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
	/** Held from the join prompt until the join RPC can carry it (UX-ID-2). */
	let hello = $state('');
	/*
	 * Bumped once the guest's profile has been written, to re-run the join
	 * effect and knock AGAIN — this time with a name the host can read.
	 *
	 * A counter rather than tracking `hello`, because `hello` only changes when
	 * the guest actually types a note. Someone who gives a name and skips the
	 * optional hello leaves it `''`, which is no change, so the effect never
	 * re-ran and the host's door list said "Someone" until they closed and
	 * reopened the panel. The existing admission test fills the hello field,
	 * which is exactly why it never noticed.
	 */
	let knocks = $state(0);

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
	 * Whether the door let us in (UX-ID-3). Until the join RPC answers we do not
	 * know, and 'admitted' is the safe assumption for the open rooms that are
	 * the common case — the canvas is gated on `store.ready` anyway, and a
	 * pending guest can never satisfy that, because every state table's RLS
	 * refuses them.
	 */
	let status = $state<'pending' | 'admitted' | 'declined'>('admitted');

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

	/** Beating before admission would be a write a pending guest may not make. */
	const admitted = $derived(status === 'admitted' && authId !== '');

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
	 * "I am still here" (AR-CTRL-3, UX-STAGE-4).
	 *
	 * Presence reaps a departed holder in about a second and is the fast path.
	 * This is the backstop it cannot be: presence-driven reaping is host-only,
	 * so a room whose only host has left would keep its ghosts — and at
	 * `max_av = 1` a ghost holds the conch, leaving the room silent.
	 *
	 * The beat also SWEEPS, server-side, which is why the interval belongs here
	 * rather than in the canvas: anyone still in the room cleans it, and a room
	 * with nobody in it needs no cleaning.
	 *
	 * Fifteen seconds, against a 45-second staleness cutoff — three missed beats
	 * before anyone is reaped, because taking the conch from someone on a slow
	 * network is worse than a ghost lingering a moment longer.
	 */
	$effect(() => {
		const name = data.room;
		if (!admitted) return;
		const beat = () => {
			void fetch(`/api/rooms/${name}/heartbeat`, { method: 'POST' })
				.then(async (response) => {
					// The beat carries the room's remaining time back with it
					// (UX-ECON-2), because it has just moved that number and is
					// already a round trip. Parsed defensively: this is the one
					// place a malformed response would put a wrong number in
					// front of people rather than merely failing.
					if (!response.ok) return;
					const body: unknown = await response.json();
					const reading = beatBudgetSchema.safeParse(body);
					if (!reading.success || reading.data.budget === null) return;
					roomBudget.report(
						reading.data.budget.usedSeconds,
						reading.data.budget.capSeconds,
						reading.data.budget.resetsAt
					);
				})
				.catch(() => {
					// A missed beat is not an error worth surfacing: the next one
					// covers it, and 45 seconds of grace is three chances. The
					// readout simply keeps its last value, which is at most 15
					// seconds stale.
				});
		};
		beat();
		const timer = setInterval(beat, 15_000);
		return () => {
			clearInterval(timer);
			// This room's number must not survive into the next one.
			roomBudget.clear();
		};
	});

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
		// Tracked purely to re-knock once the profile exists; see `knocks`.
		void knocks;
		/*
		 * `hello` is TRACKED, `identity` is not, and the asymmetry is the point.
		 *
		 * This must run on mount even with no local identity, or an account
		 * holder arriving on a new machine never fetches the profile that is
		 * supposed to follow them (UX-ID-6) — they would sit at the join prompt
		 * being asked to reinvent a name they already have.
		 *
		 * But a first-time visitor has no name at mount, so their knock would
		 * reach the host anonymous and without the hello they are about to type
		 * (UX-ID-2). Tracking `hello` re-runs this once the prompt supplies it;
		 * `join_room` is idempotent and keeps a standing decision, so knocking
		 * twice is safe and the second knock carries the note.
		 *
		 * `identity` stays UNTRACKED because this effect writes it — the roamed
		 * profile lands here. Depending on it was a read-write loop, measured at
		 * 381 mutate requests in seven seconds.
		 */
		const note = hello;

		// `identity` is passed in so a name chosen in THIS browser seeds the
		// stored profile on first sign-in, rather than being replaced by it.
		void joinRoom(room, untrack(() => identity), note).then((membership) => {
			isHost = membership.isHost;
			status = membership.status;
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

{#if data.outOfTime}
	<!--
		Before the join prompt, deliberately (UX-ECON-2). Asking someone to choose
		a name and an avatar and THEN refusing them is the worse order, and the
		refusal does not depend on who they turn out to be — the budget belongs to
		the room.
	-->
	<OutOfTime resetsAt={data.budgetResetsAt} />
{:else if identity === null}
	<JoinPrompt
		asks={data.asksAdmission}
		onjoin={(joined: StoredIdentity, message: string) => {
			// The id the server will check, not the one the prompt invented.
			const chosen = { ...joined, id: authId !== '' ? authId : joined.id };
			identity = chosen;
			// Persisted HERE rather than by `createIdentity`, which cannot know
			// the authenticated id. If the session has not resolved yet this
			// stores the placeholder, and the join handler below corrects and
			// re-saves it — so the stored value converges on the real one
			// instead of staying wrong forever.
			saveIdentity(chosen);
			// Seed the profile HERE too, not only in the join effect above. That
			// effect runs on mount, before a first-time visitor has answered this
			// prompt — so it sees no local identity, seeds nothing, and the name
			// they just chose would never leave this browser.
			//
			// `hello` is set only once this RESOLVES, and the ordering is the
			// point. Setting it earlier re-runs the join effect and knocks
			// immediately, which is a race the host loses: the knock tells them
			// to re-read, they re-read before this profile row exists, and the
			// list renders "Someone" — permanently, because nothing re-reads
			// again until they close and reopen the panel. That is the exact
			// failure the door channel exists to prevent, and it survived because
			// the admission test reopens the panel before looking.
			void saveMyProfile(supabaseBrowser(), { name: joined.name, emoji: joined.emoji })
				// `finally`, not `then`: a profile write that fails must still let
				// them knock. A host seeing "Someone" at the door beats a guest who
				// never appears at all.
				.finally(() => {
					hello = message;
					knocks += 1;
				});
		}}
	/>
{:else if status !== 'admitted'}
	<!--
		The door, not the room (UX-ID-3).

		A pending guest is refused every state table by RLS, so `store.ready`
		could never become true for them and this branch has to come FIRST — the
		alternative is a permanently blank page, which is what would have
		happened before this branch existed.
	-->
	<WaitingRoom
		roomId={data.roomId}
		guestId={authId}
		{hello}
		declined={status === 'declined'}
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
	<Room room={data.room} roomId={data.roomId} {identity} {isHost} {store} />
{/if}
