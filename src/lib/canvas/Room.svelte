<script lang="ts">
	import { untrack } from 'svelte';
	import type { StoredIdentity } from '$lib/model/types';
	import { MemoryRoomStore, AVATAR_SIZE } from '$lib/store/memory-store.svelte';
	import { SyncClient } from '$lib/store/sync-client.svelte';
	import { Viewport } from '$lib/canvas/viewport.svelte';
	import { newNote, newTimer, newChat, maxZOf } from '$lib/model/create';
	import { BACKGROUND_GRADIENTS, BACKGROUND_LEVELS } from '$lib/model/background';
	import { DEFAULT_DRAW_COLOR } from '$lib/model/palette';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import WorldCanvas from '$lib/canvas/WorldCanvas.svelte';
	import DevPanel from '$lib/dev/DevPanel.svelte';
	import EmoteBar from '$lib/canvas/EmoteBar.svelte';
	import HintBar from '$lib/canvas/HintBar.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Field from '$lib/ui/Field.svelte';
	import Popover from '$lib/ui/Popover.svelte';
	import SwatchPicker from '$lib/ui/SwatchPicker.svelte';
	import { DRAW_COLORS } from '$lib/model/palette';
	import { canonicalRoomName, roomNameMessage, roomNameProblem } from '$lib/model/room-name';
	import { counts as stageCounts, type Capacity, type StageState } from '$lib/model/stage';
	import { AVATAR_EMOJI, saveIdentity } from '$lib/model/identity';
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
	}

	let { room, identity = $bindable(EMPTY_IDENTITY) }: Props = $props();

	// Derived on `room` so in-app navigation between rooms rebuilds the
	// store instead of silently keeping the old room's channel.
	const store = $derived(new MemoryRoomStore(room, identity.id));
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
		// shape). The participants read MUST be untracked: this effect may depend
		// only on which store exists (i.e. the room), because the commit below
		// writes participants — a tracked read here is a self-retriggering loop,
		// and each re-run's cleanup would dispose the live store's channel.
		const existing = untrack(() => current.state.participants[identity.id]);
		void sync.commit({
			kind: 'upsert_participant',
			participant: {
				id: identity.id,
				name: identity.name,
				emoji: identity.emoji,
				location: existing?.location ?? { x: 0, y: 0 },
				// Carry the avatar's own size/shape across rejoins (UX-AV-1/9).
				size: existing?.size ?? { width: AVATAR_SIZE, height: AVATAR_SIZE },
				rotation: existing?.rotation ?? 0,
				clip: existing?.clip ?? { shape: 'circle' },
				fake: false,
				away: existing?.away ?? false,
				// You arrive silent and opt in by unmuting (UX-STAGE-10), which is
				// also what keeps a rejoin from silently re-taking an audio slot.
				muted: existing?.muted ?? true
			}
		});
		return () => {
			current.dispose();
		};
	});

	const count = $derived(Object.keys(store.state.participants).length);

	/**
	 * UX-STAGE-9: the room surfaces live counts and the queue with its order,
	 * so "scarcity is legible before you bump into it". Computed by the pure
	 * module — this component renders it, it does not derive it (AR-TEST-4).
	 */
	const stage = $derived<StageState>({
		capacity: store.state.capacity,
		video_holders: store.state.video_holders,
		audio_holders: store.state.audio_holders,
		queue: store.state.queue,
		mode: store.state.mode
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
		sync.announce(`Saved configuration ${name}`);
		configNameDraft = '';
	}
	/** UX-ROOM-4/6: update the configuration you are currently in. */
	function updateConfig(): void {
		void sync.commit({ kind: 'update_config' });
		sync.announce('Configuration updated');
	}
	function renameConfig(id: string, name: string): void {
		const trimmed = name.trim();
		if (trimmed === '') return;
		void sync.commit({ kind: 'rename_config', id, name: trimmed });
	}

	function switchConfig(id: string): void {
		void sync.commit({ kind: 'switch_config', id });
		sync.announce('Switched configuration');
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
	function renameRoom(): void {
		if (!renameReady) return;
		const name = canonicalRoomName(renameDraft);
		const ok = confirm(
			`Rename this room to “${name}”?\n\n` +
				'Anyone holding a link to the current name will lose access to this room. ' +
				'Links cannot be updated for them.'
		);
		if (!ok) return;
		// Carry this room's state to the new name. NOTE: the old name is not
		// truly freed in the stub — real uniqueness/freeing is server-side
		// (AR-BACKEND-10, UX-ROOM-10); old URLs still rehydrate here.
		const current = localStorage.getItem(`mumble:room:${room}`);
		if (current !== null) localStorage.setItem(`mumble:room:${name}`, current);
		void goto(resolve('/hey/[room]', { room: name }));
	}
</script>

<!--
	The toolbar measures itself into --chrome-top-drop so its popovers open
	BELOW it even after it wraps onto a second row. Wrapping is why the old
	fixed-offset menus overlapped the bar on narrow windows.
-->
<header class="bar" bind:clientHeight={barHeight} style:--chrome-top-drop="{barHeight + 20}px">
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
			{#if !mayCreate}
				<!-- Honest about a real consequence: the host role does not exist
				     yet (AR-CTRL-5), so "hosts only" currently means nobody. -->
				<p class="problem" role="alert">
					No one can add objects until the host role exists — switch back to “anyone adds”.
				</p>
			{/if}
			<div class="row">
				<Field label="New room name" bind:value={renameDraft} placeholder="new-name" />
				<Button disabled={!renameReady} onclick={renameRoom}>rename</Button>
			</div>
			{#if renameProblem !== null}
				<p class="problem" role="alert">{renameProblem}</p>
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
	<Button disabled={!mayCreate} onclick={addNote}>+ note</Button>
	<Button disabled={!mayCreate} onclick={addTimer}>+ timer</Button>
	<Button disabled={!mayCreate} onclick={addChat}>+ chat</Button>

	<Popover id="config-menu" label="configs" anchor="top-start">
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
						label="Rename configuration {config.name}"
						onclick={() => {
							const next = prompt('Rename configuration', config.name);
							if (next !== null) renameConfig(config.id, next);
						}}>✎</Button
					>
					<Button
						shape="icon"
						label="Delete configuration {config.name}"
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
					? 'Switch to a configuration to update it'
					: undefined}
				onclick={updateConfig}>⤓ update this configuration</Button
			>
			<Button
				disabled={store.state.active_config === null}
				title={store.state.active_config === null
					? 'Save a configuration first — reset restores its layout'
					: undefined}
				onclick={resetConfig}>↺ reset layout</Button
			>
			<div class="row">
				<Field label="Configuration name" bind:value={configNameDraft} placeholder="e.g. Standup" />
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
	<WorldCanvas {store} {sync} {viewport} {identity} {drawMode} {drawColor} />
	<!-- Emotes get their own bar rather than hiding behind avatar hover: one
	     always-visible launcher that can only ever act on you (UX-AV-7). -->
	<EmoteBar {store} {sync} {identity} />
	<!-- Teaches Shift-to-snap at the only moment it matters: mid-gesture. -->
	<HintBar />
	{#if import.meta.env.DEV}
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
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface);
		box-shadow: var(--shadow-1);
		font-size: var(--text-sm);
		color: var(--text);
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
