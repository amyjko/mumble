<script lang="ts">
	import type { MemoryRoomStore } from '$lib/store/memory-store.svelte';
	import type { SyncClient } from '$lib/store/sync-client.svelte';

	/**
	 * Stub-era controls. This component legitimately names MemoryRoomStore —
	 * it exists to poke the stub — but nothing under canvas/ may. It renders
	 * only in dev builds (gated at the call site).
	 */
	interface Props {
		store: MemoryRoomStore;
		sync: SyncClient;
	}

	let { store, sync }: Props = $props();

	const FAKE_EMOJI = ['🐨', '🦉', '🐰', '🦁', '🐷'];
	let fakeCount = 0;

	function addFake(): void {
		fakeCount += 1;
		void sync.commit({
			kind: 'upsert_participant',
			participant: {
				id: crypto.randomUUID(),
				name: `fake-${String(fakeCount)}`,
				emoji: FAKE_EMOJI[fakeCount % FAKE_EMOJI.length] ?? '🐨',
				location: { x: 40 * fakeCount, y: 40 * fakeCount },
				fake: true,
				raised_hand: false,
				away: false
			}
		});
	}
</script>

<aside class="panel">
	<strong>dev</strong>
	<label>
		latency {store.latencyMs}ms
		<input type="range" min="0" max="1000" step="50" bind:value={store.latencyMs} />
	</label>
	<label class="row">
		<input type="checkbox" bind:checked={store.rejectNext} />
		reject next commit
	</label>
	<button onclick={addFake}>+ fake participant</button>
	{#if sync.lastRejection !== null}
		<p class="rejection">⛔ {sync.lastRejection}</p>
	{/if}
</aside>

<style>
	.panel {
		position: fixed;
		top: var(--space-3);
		right: var(--space-3);
		z-index: var(--z-chrome);
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		width: 200px;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface);
		box-shadow: var(--shadow-1);
		font: var(--text-sm) var(--font-ui);
		color: var(--text);
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.row {
		flex-direction: row;
		align-items: center;
		gap: 6px;
	}
	button {
		min-height: var(--target-min);
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		color: var(--text);
		cursor: pointer;
	}
	.rejection {
		margin: 0;
		color: var(--danger);
	}
</style>
