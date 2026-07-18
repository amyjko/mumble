<script lang="ts">
	import { untrack } from 'svelte';
	import type { PageProps } from './$types';
	import { getOrCreateIdentity } from '$lib/model/identity';
	import { MemoryRoomStore } from '$lib/store/memory-store.svelte';
	import { SyncClient } from '$lib/store/sync-client.svelte';
	import { Viewport } from '$lib/canvas/viewport.svelte';
	import { newNote, newTimer, newChat, maxZOf } from '$lib/model/create';
	import { BACKGROUND_PRESETS } from '$lib/model/background';
	import { DEFAULT_DRAW_COLOR } from '$lib/model/palette';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import WorldCanvas from '$lib/canvas/WorldCanvas.svelte';
	import DevPanel from '$lib/dev/DevPanel.svelte';

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
	let drawColor = $state(DEFAULT_DRAW_COLOR);
	let renameDraft = $state('');
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

<header class="bar">
	<details class="room">
		<summary><strong>{store.state.title === '' ? data.room : store.state.title}</strong></summary>
		<div class="room-menu">
			<label class="field">
				Title
				<input
					aria-label="Room title"
					value={store.state.title}
					placeholder={data.room}
					onchange={(e) => {
						saveMeta(e.currentTarget.value, store.state.description);
					}}
				/>
			</label>
			<label class="field">
				Description
				<textarea
					aria-label="Room description"
					value={store.state.description}
					onchange={(e) => {
						saveMeta(store.state.title, e.currentTarget.value);
					}}
				></textarea>
			</label>
			<label class="field">
				Rename room
				<span class="rename-row">
					<input bind:value={renameDraft} aria-label="New room name" placeholder="new-name" />
					<button type="button" onclick={renameRoom}>rename</button>
				</span>
			</label>
		</div>
	</details>
	<span class="count">{count} here</span>
	<button class="add" onclick={addNote}>+ note</button>
	<button class="add" onclick={addTimer}>+ timer</button>
	<button class="add" onclick={addChat}>+ chat</button>
	<details class="bg">
		<summary>background</summary>
		<div class="bg-menu">
			{#each BACKGROUND_PRESETS as preset (preset.name)}
				<button
					type="button"
					onclick={() => {
						setBackground(preset.value);
					}}>{preset.name}</button
				>
			{/each}
			<label class="bg-custom">
				custom
				<input
					type="color"
					aria-label="Custom background color"
					oninput={(e) => {
						setBackground(e.currentTarget.value);
					}}
				/>
			</label>
		</div>
	</details>
	<button
		class="add"
		aria-pressed={drawMode}
		onclick={() => {
			drawMode = !drawMode;
		}}>✎ draw</button
	>
	{#if drawMode}
		<input type="color" aria-label="Draw color" bind:value={drawColor} />
	{/if}
	<span class="hint">or double-click the canvas</span>
</header>

<main>
	<WorldCanvas {store} {sync} {viewport} {identity} {drawMode} {drawColor} />
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
		z-index: 10000;
		display: flex;
		gap: var(--space-3);
		align-items: center;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface);
		box-shadow: var(--shadow-1);
		font-size: var(--text-sm);
		color: var(--text);
	}
	.count {
		color: var(--text-muted);
	}
	.add {
		min-height: var(--target-min);
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		color: var(--text);
		font-size: var(--text-sm);
		cursor: pointer;
	}
	.add[aria-pressed='true'] {
		background: var(--accent);
		color: var(--accent-contrast);
		border-color: var(--accent);
	}
	.hint {
		color: var(--text-muted);
	}
	.room summary {
		cursor: pointer;
		min-height: var(--target-min);
		display: inline-flex;
		align-items: center;
	}
	.room-menu {
		position: absolute;
		margin-top: var(--space-1);
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		width: 260px;
		padding: var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface);
		box-shadow: var(--shadow-2);
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	.field input,
	.field textarea {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		color: var(--text);
		padding: var(--space-1) var(--space-2);
		font: var(--text-sm) var(--font-ui);
	}
	.rename-row {
		display: flex;
		gap: var(--space-1);
	}
	.rename-row button {
		min-height: var(--target-min);
		padding: 0 var(--space-2);
		border: 1px solid var(--accent);
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: var(--accent-contrast);
		cursor: pointer;
	}
	.bg summary {
		cursor: pointer;
		color: var(--text-muted);
		min-height: var(--target-min);
		display: inline-flex;
		align-items: center;
	}
	.bg-menu {
		position: absolute;
		margin-top: var(--space-1);
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding: var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface);
		box-shadow: var(--shadow-2);
	}
	.bg-menu button {
		min-height: var(--target-min);
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		color: var(--text);
		font: var(--text-sm) var(--font-ui);
		cursor: pointer;
		text-align: left;
	}
	.bg-custom {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	main {
		position: fixed;
		inset: 0;
	}
</style>
