<script lang="ts">
	import { untrack } from 'svelte';
	import type { PageProps } from './$types';
	import { getOrCreateIdentity } from '$lib/model/identity';
	import { MemoryRoomStore, AVATAR_SIZE } from '$lib/store/memory-store.svelte';
	import { SyncClient } from '$lib/store/sync-client.svelte';
	import { Viewport } from '$lib/canvas/viewport.svelte';
	import { newNote, newTimer, newChat, maxZOf } from '$lib/model/create';
	import { BACKGROUND_LEVELS } from '$lib/model/background';
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

	let { data }: PageProps = $props();

	// ssr=false: all of this runs client-side only.
	const identity = getOrCreateIdentity();
	// Derived on data.room so in-app navigation between rooms rebuilds the
	// store instead of silently keeping the old room's channel.
	const store = $derived(new MemoryRoomStore(data.room, identity.id));
	const sync = $derived(new SyncClient(store));
	const viewport = new Viewport();

	// Draw mode + color are per-viewer view state (UX-OBJ-11 capture).
	let drawMode = $state(false);
	/** Measured so popovers clear the toolbar even when it wraps. */
	let barHeight = $state(0);
	let drawColor = $state(DEFAULT_DRAW_COLOR);
	let renameDraft = $state('');
	let configNameDraft = $state('');
	const ROOM_NAME = /^[a-z0-9_-]{2,32}$/i;

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
				raised_hand: existing?.raised_hand ?? false,
				away: existing?.away ?? false
			}
		});
		return () => {
			current.dispose();
		};
	});

	const count = $derived(Object.keys(store.state.participants).length);
	/** Stub-only: chat history evicted to bound localStorage (CHAT_LOG_LIMIT). */
	const dropped = $derived(store instanceof MemoryRoomStore ? store.droppedChatMessages : 0);

	/** Pointer-free creation (UX-A11Y-2) at the viewport center. */
	function centerWorld(): { x: number; y: number } {
		return viewport.toWorld({ x: viewport.size.width / 2, y: viewport.size.height / 2 });
	}
	function addNote(): void {
		const objects = untrack(() => Object.values(store.state.objects));
		void sync.commit({ kind: 'create_object', object: newNote(identity.id, centerWorld(), maxZOf(objects)) });
		sync.announce('Note added');
	}
	function addTimer(): void {
		const objects = untrack(() => Object.values(store.state.objects));
		void sync.commit({ kind: 'create_object', object: newTimer(identity.id, centerWorld(), maxZOf(objects)) });
		sync.announce('Timer added');
	}
	function addChat(): void {
		const objects = untrack(() => Object.values(store.state.objects));
		void sync.commit({ kind: 'create_object', object: newChat(identity.id, centerWorld(), maxZOf(objects)) });
		sync.announce('Chat added');
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
	function renameRoom(): void {
		const name = renameDraft.trim().toLowerCase();
		if (!ROOM_NAME.test(name) || name === data.room) return;
		// Carry this room's state to the new name. NOTE: the old name is not
		// truly freed in the stub — real uniqueness/freeing is server-side
		// (AR-BACKEND-10, UX-ROOM-10); old URLs still rehydrate here.
		const current = localStorage.getItem(`mumble:room:${data.room}`);
		if (current !== null) localStorage.setItem(`mumble:room:${name}`, current);
		void goto(resolve('/hey/[room]', { room: name }));
	}
</script>

<svelte:head>
	<title>{data.room} · mumble</title>
</svelte:head>

<!--
	The toolbar measures itself into --chrome-top-drop so its popovers open
	BELOW it even after it wraps onto a second row. Wrapping is why the old
	fixed-offset menus overlapped the bar on narrow windows.
-->
<header class="bar" bind:clientHeight={barHeight} style:--chrome-top-drop="{barHeight + 20}px">
	<Popover id="room-menu" label="Room settings" anchor="top-start">
		{#snippet trigger()}
			<strong>{store.state.title === '' ? data.room : store.state.title}</strong>
		{/snippet}
		<div class="menu">
			<Field
				label="Room title"
				value={store.state.title}
				placeholder={data.room}
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
			<div class="row">
				<Field label="New room name" bind:value={renameDraft} placeholder="new-name" />
				<Button onclick={renameRoom}>rename</Button>
			</div>
		</div>
	</Popover>

	<span class="count">{count} here</span>
	<Button onclick={addNote}>+ note</Button>
	<Button onclick={addTimer}>+ timer</Button>
	<Button onclick={addChat}>+ chat</Button>

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
	.warn {
		color: var(--danger);
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
</style>
