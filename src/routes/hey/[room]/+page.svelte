<script lang="ts">
	import { untrack } from 'svelte';
	import type { PageProps } from './$types';
	import { getOrCreateIdentity } from '$lib/model/identity';
	import { MemoryRoomStore } from '$lib/store/memory-store.svelte';
	import { SyncClient } from '$lib/store/sync-client.svelte';
	import { Viewport } from '$lib/canvas/viewport.svelte';
	import { newNote, newTimer, maxZOf } from '$lib/model/create';
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
				fake: false
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
</script>

<svelte:head>
	<title>{data.room} · mumble</title>
</svelte:head>

<header class="bar">
	<strong>/hey/{data.room}</strong>
	<span class="count">{count} here</span>
	<button class="add" onclick={addNote}>+ note</button>
	<button class="add" onclick={addTimer}>+ timer</button>
	<span class="hint">or double-click the canvas</span>
</header>

<main>
	<WorldCanvas {store} {sync} {viewport} {identity} />
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
	.hint {
		color: var(--text-muted);
	}
	main {
		position: fixed;
		inset: 0;
	}
</style>
