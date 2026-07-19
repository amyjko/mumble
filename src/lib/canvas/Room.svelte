<script lang="ts">
	import { untrack } from 'svelte';
	import { z } from 'zod';
	import type { StoredIdentity } from '$lib/model/types';
	import { MemoryRoomStore } from '$lib/store/memory-store.svelte';
	import type { RoomStore } from '$lib/store/room-store';
	import { AVATAR_SIZE, newParticipant } from '$lib/model/avatar';
	import { SyncClient } from '$lib/store/sync-client.svelte';
	import { Viewport } from '$lib/canvas/viewport.svelte';
	import { newNote, newTimer, newChat, maxZOf } from '$lib/model/create';
	import { BACKGROUND_GRADIENTS, BACKGROUND_LEVELS } from '$lib/model/background';
	import { DEFAULT_DRAW_COLOR } from '$lib/model/palette';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import WorldCanvas from '$lib/canvas/WorldCanvas.svelte';
	import DevPanel from '$lib/dev/DevPanel.svelte';
	import BottomBar from '$lib/canvas/BottomBar.svelte';
	import HintBar from '$lib/canvas/HintBar.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Field from '$lib/ui/Field.svelte';
	import Popover from '$lib/ui/Popover.svelte';
	import SwatchPicker from '$lib/ui/SwatchPicker.svelte';
	import { DRAW_COLORS } from '$lib/model/palette';
	import { canonicalRoomName, roomNameMessage, roomNameProblem } from '$lib/model/room-name';
	import { wasDisplaced } from '$lib/model/placement';
	import { canDesignRoom } from '$lib/model/permissions';
	import { counts as stageCounts, type Capacity, type StageState } from '$lib/model/stage';
	import { AVATAR_EMOJI, saveIdentity } from '$lib/model/identity';
	import { saveMyProfile } from '$lib/auth/profile';
	import { supabaseBrowser } from '$lib/auth/browser-client';
	import { ADD_EMOJI } from '$lib/model/emotes';
	import EmojiPicker from '$lib/ui/EmojiPicker.svelte';
	import Emoji from '$lib/ui/Emoji.svelte';

	/**
	 * Never used: Room is only rendered with a real identity (the route gates
	 * on it). It exists because a $bindable prop needs a default, and inventing
	 * a name here would resurrect exactly what UX-ID-1 forbids — so it is
	 * deliberately unusable rather than plausible.
	 */
	const EMPTY_IDENTITY: StoredIdentity = { id: '', name: '', emoji: '' };

	interface Props {
		/** Canonical room name from the route. */
		room: string;
		/**
		 * Who you are. NON-NULLABLE by design: a room cannot be entered without
		 * an identity (UX-ID-1 requires a name), so the component that needs one
		 * demands it rather than defending against its absence.
		 */
		identity?: StoredIdentity | undefined;
		/**
		 * Whether you hold the host role in THIS room (UX-PERM-3). Supplied by
		 * the route from a room_members row; never inferred here, and never
		 * trusted by the server, which reads its own membership row.
		 */
		isHost?: boolean | undefined;
		/**
		 * The backend, INJECTED (AR-SYNC-3).
		 *
		 * This component used to construct `MemoryRoomStore` itself, which broke
		 * room-store.ts's own rule that no consumer may name a backend — and made
		 * the stub impossible to swap without editing the canvas. The route
		 * supplies `SupabaseRoomStore`; anything that wants the stub passes it.
		 *
		 * Constructing it here was also what made the store a `$derived` on
		 * IDENTITY: it took `identity.id`, so the store and its Realtime channel
		 * were rebuilt every time anonymous sign-in, the join RPC, or a roamed
		 * profile landed. Ownership of the lifetime belongs with whoever knows
		 * the room, not with whoever knows the actor.
		 */
		store: RoomStore;
	}

	let { room, identity = $bindable(EMPTY_IDENTITY), isHost = false, store }: Props = $props();
	const sync = $derived(new SyncClient(store));
	const viewport = new Viewport();

	// Draw mode + color are per-viewer view state (UX-OBJ-11 capture).
	let drawMode = $state(false);
	/** Measured so popovers clear the toolbar even when it wraps. */
	let barHeight = $state(0);
	let drawColor = $state(DEFAULT_DRAW_COLOR);
	let renameDraft = $state('');
	/** Drafts for the "you" editor, seeded from the current identity. */
	let nameDraft = $state(identity.name);
	let emojiDraft = $state(identity.emoji);
	const identityReady = $derived(nameDraft.trim() !== '');
	let configNameDraft = $state('');

	$effect(() => {
		const current = store;
		// Join: upsert self at the last known location, else the default spot;
		// the store resolves collisions to the nearest legal position (AR-CTRL-4's
		// shape). The participants read MUST be untracked, because the commit
		// below writes participants and a tracked read here is a
		// self-retriggering loop.
		const existing = untrack(() => current.state.participants[identity.id]);
		void sync.commit({
			kind: 'upsert_participant',
			participant: newParticipant(identity, { existing })
		});
		// NO cleanup disposing the store. This component does not own it any
		// more — the route builds it per room and disposes it. Disposing here
		// closed the Realtime channel of a LIVE store every time `identity`
		// changed, which it does moments after mount when the roamed profile
		// lands: the page then looked fine and silently received no broadcast
		// again, which is how a second tab ended up never seeing the first's
		// edits.
	});

	const count = $derived(Object.keys(store.state.participants).length);
	/** Placers are a host tool (UX-AV-2), and the gate is live now. */
	const canDesign = $derived(canDesignRoom(isHost));

	/**
	 * Say so when the room moved you (AR-CTRL-4).
	 *
	 * Entry re-validates a remembered location rather than trusting it, so
	 * someone who returns to a spot that content has since taken lands
	 * somewhere else. That was correct but SILENT — you came back, you were
	 * somewhere new, and nothing accounted for it. Sighted users at least see
	 * the difference; without vision there was no signal at all.
	 *
	 * Derived, not plumbed: both the remembered spot and the actual one are
	 * already in room state, so the displacement is a comparison rather than a
	 * new channel through the store seam.
	 */
	const displaced = $derived(wasDisplaced(store.state, identity.id));
	let announcedDisplacement = false;
	$effect(() => {
		if (!displaced) {
			announcedDisplacement = false;
			return;
		}
		if (announcedDisplacement) return;
		announcedDisplacement = true;
		sync.announce('Your usual spot was taken, so you were placed nearby');
	});

	/**
	 * UX-STAGE-9: the room surfaces live counts and the queue with its order,
	 * so "scarcity is legible before you bump into it". Computed by the pure
	 * module — this component renders it, it does not derive it (AR-TEST-4).
	 */
	const stage = $derived<StageState>({
		capacity: store.state.capacity,
		video_holders: store.state.video_holders,
		audio_holders: store.state.audio_holders,
		queue: store.state.queue
	});
	const slots = $derived(stageCounts(stage));
	const nameOf = (id: string): string => store.state.participants[id]?.name ?? 'Someone';

	function setCapacity(next: Partial<Capacity>): void {
		void sync.commit({ kind: 'set_capacity', capacity: { ...stage.capacity, ...next } });
	}
	/** Stub-only: chat history evicted to bound localStorage (CHAT_LOG_LIMIT). */
	const dropped = $derived(store instanceof MemoryRoomStore ? store.droppedChatMessages : 0);

	/** Pointer-free creation (UX-A11Y-2) at the viewport center. */
	function centerWorld(): { x: number; y: number } {
		return viewport.toWorld({ x: viewport.size.width / 2, y: viewport.size.height / 2 });
	}
	function addNote(): void {
		const objects = untrack(() => Object.values(store.state.objects));
		void sync.commit({ kind: 'create_object', object: newNote(identity.id, centerWorld(), maxZOf(objects), store.state.border_default) });
		sync.announce('Note added');
	}
	function addTimer(): void {
		const objects = untrack(() => Object.values(store.state.objects));
		void sync.commit({ kind: 'create_object', object: newTimer(identity.id, centerWorld(), maxZOf(objects), store.state.border_default) });
		sync.announce('Timer added');
	}
	/**
	 * Lay out a spot for the next newcomer (UX-AV-2). Created at the viewport
	 * centre like any other addition, sized to the default avatar so the host
	 * sees the footprint an arrival will actually take.
	 */
	function addPlacer(): void {
		const at = centerWorld();
		void sync.commit({
			kind: 'add_placer',
			placer: {
				id: crypto.randomUUID(),
				x: at.x,
				y: at.y,
				width: AVATAR_SIZE,
				height: AVATAR_SIZE,
				rotation: 0,
				clip: { shape: 'circle' }
			}
		});
		sync.announce(`Newcomer spot ${String(store.state.placers.length + 1)} added`);
	}
	function addChat(): void {
		const objects = untrack(() => Object.values(store.state.objects));
		void sync.commit({ kind: 'create_object', object: newChat(identity.id, centerWorld(), maxZOf(objects), store.state.border_default) });
		sync.announce('Chat added');
	}
	/**
	 * Change your own name/face (UX-ID-1, UX-AV-3). Writes BOTH the per-browser
	 * identity and the room's participant record: the first is what you carry
	 * to other rooms, the second is what this room shows. `saveIdentity` was
	 * exported and never called until now, so a chosen name could not survive
	 * a reload.
	 */
	function saveMe(): void {
		if (!identityReady) return;
		const next = { ...identity, name: nameDraft.trim(), emoji: emojiDraft };
		saveIdentity(next);
		identity = next;
		void sync.commit({ kind: 'set_identity', id: identity.id, name: next.name, emoji: next.emoji });

		// THREE places, because they answer three different questions:
		//   localStorage — who am I in this browser, offline, before any network
		//   the room     — who is that on the canvas, for everyone here now
		//   the profile  — who am I everywhere, on my next machine (UX-ID-6)
		// Writing only the first two is what made a second machine show a
		// stranger's blank face.
		void saveMyProfile(supabaseBrowser(), { name: next.name, emoji: next.emoji });
		sync.announce('Your name and face were updated');
	}

	/** UX-OBJ-9: creation permission is a ROOM setting, default all-may-create. */
	const mayCreate = $derived(store.state.create_permission === 'all');
	function setCreatePermission(value: 'all' | 'host'): void {
		void sync.commit({ kind: 'set_room_create_permission', value });
		sync.announce(value === 'all' ? 'Anyone can add objects' : 'Only hosts can add objects');
	}

	function setBackground(value: string): void {
		void sync.commit({ kind: 'set_background', value });
		sync.announce('Background changed');
	}
	function saveMeta(title: string, description: string): void {
		void sync.commit({ kind: 'set_room_meta', title, description });
	}
	function saveConfig(): void {
		const name = configNameDraft.trim();
		if (name === '') return;
		void sync.commit({ kind: 'save_config', id: crypto.randomUUID(), name });
		sync.announce(`Saved layout ${name}`);
		configNameDraft = '';
	}
	/** UX-ROOM-4/6: update the configuration you are currently in. */
	function updateConfig(): void {
		void sync.commit({ kind: 'update_config' });
		sync.announce('Layout updated');
	}
	function renameConfig(id: string, name: string): void {
		const trimmed = name.trim();
		if (trimmed === '') return;
		void sync.commit({ kind: 'rename_config', id, name: trimmed });
	}

	function switchConfig(id: string): void {
		void sync.commit({ kind: 'switch_config', id });
		sync.announce('Switched layout');
	}
	function resetConfig(): void {
		void sync.commit({ kind: 'reset_config' });
		sync.announce('Layout reset');
	}
	function deleteConfig(id: string): void {
		void sync.commit({ kind: 'delete_config', id });
	}
	/** Why the rename cannot proceed, or null. Shown next to the field. */
	const renameProblem = $derived.by(() => {
		if (renameDraft.trim() === '') return null;
		const problem = roomNameProblem(renameDraft);
		if (problem !== null) return roomNameMessage(problem);
		if (canonicalRoomName(renameDraft) === room) return 'That is already this room\u2019s name.';
		return null;
	});
	const renameReady = $derived(renameDraft.trim() !== '' && renameProblem === null);

	/**
	 * UX-ROOM-10 requires hosts be WARNED before renaming, because existing
	 * links break. That warning was simply missing — and unlike the two
	 * behaviors the stub cannot yet honor (freeing the old name, and old URLs
	 * ceasing to resolve), nothing admitted its absence.
	 */
	/** SvelteKit's error body, for reporting a refused rename. */
	const z_message = z.object({ message: z.string() });

	function renameRoom(): void {
		if (!renameReady) return;
		const name = canonicalRoomName(renameDraft);
		const ok = confirm(
			`Rename this room to “${name}”?\n\n` +
				'Anyone holding a link to the current name will lose access to this room. ' +
				'Links cannot be updated for them.'
		);
		if (!ok) return;
		// The room is renamed SERVER-side and then navigated to. The stub used to
		// copy one localStorage key to another, which worked only because it
		// conjured a room for any name and freed nothing — so the warning above
		// was not yet true. It is now: the old name is released by the same
		// update, and old links stop resolving.
		void (async () => {
			const response = await fetch(`/api/rooms/${room}/rename`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!response.ok) {
				const problem: unknown = await response.json().catch(() => null);
				const message = z_message.safeParse(problem);
				sync.announce(
					`Rename failed: ${message.success ? message.data.message : 'the room was not renamed'}`
				);
				return;
			}
			await goto(resolve('/hey/[room]', { room: name }));
		})();
	}
</script>

<!--
	The toolbar measures itself into --chrome-top-drop so its popovers open
	BELOW it even after it wraps onto a second row. Wrapping is why the old
	fixed-offset menus overlapped the bar on narrow windows.
-->
<header class="bar panel" bind:clientHeight={barHeight} style:--chrome-top-drop="{barHeight + 20}px">
	<Popover id="room-menu" label="Room settings" anchor="top-start">
		{#snippet trigger()}
			<strong>{store.state.title === '' ? room : store.state.title}</strong>
		{/snippet}
		<div class="menu">
			<Field
				label="Room title"
				value={store.state.title}
				placeholder={room}
				oncommit={(title: string) => {
					saveMeta(title, store.state.description);
				}}
			/>
			<Field
				label="Room description"
				multiline
				value={store.state.description}
				oncommit={(description: string) => {
					saveMeta(store.state.title, description);
				}}
			/>
			<div class="row" role="group" aria-label="Who can add objects">
				<Button
					pressed={mayCreate}
					onclick={() => {
						setCreatePermission('all');
					}}>anyone adds</Button
				>
				<Button
					pressed={!mayCreate}
					onclick={() => {
						setCreatePermission('host');
					}}>hosts only</Button
				>
			</div>
			{#if !mayCreate && !isHost}
				<!-- The warning that used to say "hosts only means nobody" is gone:
				     the role exists (AR-CTRL-7), so the setting does what it says.
				     What remains is telling a GUEST why the add buttons are dead,
				     which is otherwise indistinguishable from a broken toolbar. -->
				<p class="problem" role="alert">Only a host can add objects in this room.</p>
			{/if}
			<!-- Host-only, because the server now enforces it (UX-ROOM-10). Offered
			     to everyone, it was a control that could only ever fail — and
			     while the rename was stub-local it appeared to work for guests
			     too, which is worse than refusing them. -->
			{#if isHost}
				<div class="row">
					<Field label="New room name" bind:value={renameDraft} placeholder="new-name" />
					<Button disabled={!renameReady} onclick={renameRoom}>rename</Button>
				</div>
				{#if renameProblem !== null}
					<p class="problem" role="alert">{renameProblem}</p>
				{/if}
			{/if}
		</div>
	</Popover>

	<Popover id="me-menu" label="You" anchor="top-start">
		{#snippet trigger()}
			<Emoji glyph={identity.emoji} /> {identity.name}
		{/snippet}
		<div class="menu">
			<Field label="Your name" bind:value={nameDraft} placeholder="e.g. Amy" />
			<fieldset class="faces">
				<legend>Your face</legend>
				<EmojiPicker label="Your face" bind:value={emojiDraft} choices={AVATAR_EMOJI} />
			</fieldset>
			<Button variant="primary" disabled={!identityReady} onclick={saveMe}>save</Button>
		</div>
	</Popover>

	<span class="count">{count} here</span>
	<span class="count" aria-label="Stage capacity">
		{slots.video.held}/{slots.video.max} video · {slots.audio.held}/{slots.audio.max} audio
	</span>

	<Popover id="stage-menu" label="stage" anchor="top-start">
		<div class="menu">
			<p class="hint">
				Three numbers are the whole stage policy (UX-STAGE-2): one video slot is a
				turn-taking conch, many is a gallery.
			</p>
			<div class="row">
				<Field
					label="Video slots"
					value={String(stage.capacity.max_av)}
					oncommit={(v: string) => {
						setCapacity({ max_av: Number(v) || 0 });
					}}
				/>
				<Field
					label="Audio slots"
					value={String(stage.capacity.max_audio)}
					oncommit={(v: string) => {
						setCapacity({ max_audio: Number(v) || 0 });
					}}
				/>
				<Field
					label="Max people"
					value={String(stage.capacity.max_participants)}
					oncommit={(v: string) => {
						setCapacity({ max_participants: Number(v) || 1 });
					}}
				/>
			</div>
			{#if stage.queue.length > 0}
				<p class="hint">Waiting for a slot, in order:</p>
				<ol class="queue">
					{#each stage.queue as waiting, index (waiting)}
						<li>{index + 1}. {nameOf(waiting)}</li>
					{/each}
				</ol>
			{:else}
				<p class="hint">Nobody is waiting.</p>
			{/if}
		</div>
	</Popover>
	<Button disabled={!mayCreate} onclick={addNote}>+ <Emoji glyph={ADD_EMOJI.note} /> note</Button>
	<Button disabled={!mayCreate} onclick={addTimer}>+ <Emoji glyph={ADD_EMOJI.timer} /> timer</Button>
	<Button disabled={!mayCreate} onclick={addChat}>+ <Emoji glyph={ADD_EMOJI.chat} /> chat</Button>
	<!-- A host tool, not content: placers say where NEWCOMERS land (UX-AV-2). -->
	{#if canDesign}
		<Button onclick={addPlacer}>+ <Emoji glyph={ADD_EMOJI.placer} /> newcomer spot</Button>
	{/if}

	<Popover id="config-menu" label="layouts" anchor="top-start">
		<div class="menu">
			{#each Object.values(store.state.configurations) as config (config.id)}
				<div class="row">
					<Button
						pressed={store.state.active_config === config.id}
						onclick={() => {
							switchConfig(config.id);
						}}>{config.name}</Button
					>
					<Button
						shape="icon"
						label="Rename layout {config.name}"
						onclick={() => {
							const next = prompt('Rename layout', config.name);
							if (next !== null) renameConfig(config.id, next);
						}}>✎</Button
					>
					<Button
						shape="icon"
						label="Delete layout {config.name}"
						onclick={() => {
							deleteConfig(config.id);
						}}>×</Button
					>
				</div>
			{/each}
			<!--
				Reset restores the ACTIVE configuration's layout (UX-ROOM-5), so with
				no configuration saved there is nothing to restore. It used to be
				offered anyway and silently do nothing; now it says why.
			-->
			<!--
				Update the ACTIVE configuration in place. Before this, "save" always
				minted a new id, so configurations accumulated and could never be
				corrected — you could only ever add another near-duplicate.
			-->
			<Button
				variant="primary"
				disabled={store.state.active_config === null}
				title={store.state.active_config === null
					? 'Switch to a layout to update it'
					: undefined}
				onclick={updateConfig}>⤓ update this layout</Button
			>
			<Button
				disabled={store.state.active_config === null}
				title={store.state.active_config === null
					? 'Save a layout first — reset restores it'
					: undefined}
				onclick={resetConfig}>↺ reset layout</Button
			>
			<div class="row">
				<Field label="Layout name" bind:value={configNameDraft} placeholder="e.g. Standup" />
				<Button onclick={saveConfig}>save</Button>
			</div>
		</div>
	</Popover>

	<Popover id="bg-menu" label="background" anchor="top-start">
		<!-- Brightness levels are mutually exclusive, so: a radiogroup. -->
		<div class="menu" role="radiogroup" aria-label="Room brightness">
			{#each BACKGROUND_LEVELS as level (level.name)}
				<Button
					pressed={store.state.background === level.value}
					onclick={() => {
						setBackground(level.value);
					}}>{level.name}</Button
				>
			{/each}
			<hr />
			<div class="menu" role="radiogroup" aria-label="Room gradient">
				{#each BACKGROUND_GRADIENTS as gradient (gradient.name)}
					<Button
						pressed={store.state.background === gradient.value}
						onclick={() => {
							setBackground(gradient.value);
						}}>{gradient.name}</Button
					>
				{/each}
			</div>
		</div>
	</Popover>

	<Button
		pressed={drawMode}
		onclick={() => {
			drawMode = !drawMode;
		}}>✎ draw</Button
	>
	{#if drawMode}
		<SwatchPicker label="Draw color" bind:value={drawColor} swatches={DRAW_COLORS} />
	{/if}
	{#if dropped > 0}
		<!-- The stub evicts old chat messages to bound localStorage (UX-OBJ-3
		     deviation). Saying so beats losing history silently. -->
		<span class="warn" role="status"
			>{dropped} old chat {dropped === 1 ? 'message' : 'messages'} dropped (stub storage limit)</span
		>
	{/if}
	<span class="hint">double-click the canvas to add a note</span>
</header>

<main>
	<WorldCanvas {store} {sync} {viewport} {identity} {isHost} {drawMode} {drawColor} />
	<!-- ONE bottom toolbar: emotes, camera, and theme. Three separate floating
	     clusters used to compete for this corner and overlap each other. -->
	<BottomBar {store} {sync} {identity} {viewport} />
	<!-- Teaches Shift-to-snap at the only moment it matters: mid-gesture. -->
	<HintBar />
	<!-- Stub-only: the panel injects latency and forces rejections, levers that
	     do not exist against the real backend. Dead controls would be worse
	     than an absent panel. -->
	{#if import.meta.env.DEV && store instanceof MemoryRoomStore}
		<DevPanel {store} {sync} />
	{/if}
</main>

<!-- Transient outcomes are perceivable without vision (UX-A11Y-3). -->
<div class="sr-only" aria-live="polite">{sync.announcement}</div>

<style>
	.bar {
		position: fixed;
		top: var(--space-3);
		left: var(--space-3);
		z-index: var(--z-chrome);
		display: flex;
		/* Wrap instead of overflowing. It was a hard non-wrapping row, so on a
		   narrow window the right-hand controls ran off-screen with no scroll
		   to reach them (main is fixed; inset: 0). */
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: center;
		/* Never wider than the viewport, and never taller than it either. */
		max-width: calc(100vw - 2 * var(--space-3));
		max-height: calc(100vh - 2 * var(--space-3));
		overflow: auto;
		padding: var(--space-2) var(--space-3);
		font-size: var(--text-sm);
	}
	.count,
	.hint {
		color: var(--text-muted);
	}
	.hint {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.queue {
		margin: 0;
		padding-left: var(--space-4);
		font-size: var(--text-sm);
	}
	.warn,
	.problem {
		color: var(--danger);
	}
	.problem {
		margin: 0;
		font-size: var(--text-sm);
	}
	/* Popover body layout only; Field and Button paint themselves. */
	.menu {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.row {
		display: flex;
		gap: var(--space-1);
		align-items: flex-end;
	}
	.faces {
		margin: 0;
		padding: 0;
		border: none;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.faces legend {
		padding: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
</style>
