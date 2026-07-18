<script lang="ts">
	import type { TimerCanvasObject, TimerPayload } from '$lib/model/types';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import { displayMs, formatMs, isFinished, started, paused, reset } from '$lib/model/timer';

	interface Props {
		object: TimerCanvasObject;
		sync: SyncClient;
		editable: boolean;
	}

	let { object, sync, editable }: Props = $props();

	// Local clock for display only; the shared payload is the source of truth,
	// so every viewer renders the same time (UX-OBJ-4). Date.now() is a number,
	// not a Date instance — clear of the svelte-reactivity lint rule.
	let now = $state(Date.now());
	$effect(() => {
		if (!object.payload.running) return;
		const id = setInterval(() => {
			now = Date.now();
		}, 250);
		return () => {
			clearInterval(id);
		};
	});

	const display = $derived(formatMs(displayMs(object.payload, now)));
	const finished = $derived(isFinished(object.payload, now));

	function commit(payload: TimerPayload): void {
		void sync.commit({ kind: 'edit_timer', id: object.id, payload });
	}

	function toggle(): void {
		const p = object.payload.running ? paused(object.payload, Date.now()) : started(object.payload, Date.now());
		commit(p);
		sync.announce(p.running ? 'Timer started' : 'Timer paused');
	}
	function doReset(): void {
		commit(reset(object.payload));
		sync.announce('Timer reset');
	}
	function setMode(mode: TimerPayload['mode']): void {
		commit({ ...reset(object.payload), mode });
	}
	function adjustDuration(deltaMs: number): void {
		const durationMs = Math.max(0, object.payload.durationMs + deltaMs);
		commit({ ...reset(object.payload), durationMs });
	}
</script>

<div class="timer" class:finished>
	<output class="readout" aria-label="{object.payload.mode} timer">{display}</output>
	{#if editable}
		<div class="controls">
			<button
				class="primary"
				aria-pressed={object.payload.running}
				onpointerdown={(e) => {
					e.stopPropagation();
				}}
				onclick={toggle}>{object.payload.running ? 'Pause' : 'Start'}</button
			>
			<button
				aria-label="Reset timer"
				onpointerdown={(e) => {
					e.stopPropagation();
				}}
				onclick={doReset}>↺</button
			>
		</div>
		<div class="config">
			<button
				aria-pressed={object.payload.mode === 'countdown'}
				onpointerdown={(e) => {
					e.stopPropagation();
				}}
				onclick={() => {
					setMode(object.payload.mode === 'countdown' ? 'countup' : 'countdown');
				}}
				>{object.payload.mode === 'countdown' ? '↓ countdown' : '↑ count up'}</button
			>
			{#if object.payload.mode === 'countdown'}
				<button
					aria-label="Subtract one minute"
					onpointerdown={(e) => {
						e.stopPropagation();
					}}
					onclick={() => {
						adjustDuration(-60_000);
					}}>−1m</button
				>
				<button
					aria-label="Add one minute"
					onpointerdown={(e) => {
						e.stopPropagation();
					}}
					onclick={() => {
						adjustDuration(60_000);
					}}>+1m</button
				>
			{/if}
		</div>
	{/if}
</div>

<style>
	.timer {
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		container-type: inline-size;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-1);
		background: var(--surface);
		color: var(--text);
		padding: var(--space-2);
	}
	.readout {
		font: 600 var(--text-lg) / 1 var(--font-mono);
		font-size: clamp(20px, 22cqi, 40px);
		font-variant-numeric: tabular-nums;
	}
	.timer.finished .readout {
		color: var(--danger);
	}
	.controls,
	.config {
		display: flex;
		gap: var(--space-1);
		flex-wrap: wrap;
		justify-content: center;
	}
	button {
		min-height: var(--target-min);
		padding: 0 var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		color: var(--text);
		font: var(--text-xs) var(--font-ui);
		cursor: pointer;
	}
	button.primary[aria-pressed='true'],
	button[aria-pressed='true'] {
		background: var(--accent);
		color: var(--accent-contrast);
		border-color: var(--accent);
	}
</style>
