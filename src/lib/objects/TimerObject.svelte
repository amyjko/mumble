<script lang="ts">
	import type { TimerCanvasObject, TimerPayload } from '$lib/model/types';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import { displayMs, formatMs, isFinished, started, paused, reset } from '$lib/model/timer';
	import Button from '$lib/ui/Button.svelte';
	import { stopPointer } from '$lib/ui/events';

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
			<!--
				Start/Pause names the ACTION, with no aria-pressed. It used to carry
				both a changing label and a changing pressed state, which is the same
				ambiguity the mode control had: you could not tell whether the button
				described the current state or what clicking would do.
			-->
			<Button variant="primary" onpointerdown={stopPointer} onclick={toggle}>
				{object.payload.running ? 'Pause' : 'Start'}
			</Button>
			<Button shape="icon" label="Reset timer" onpointerdown={stopPointer} onclick={doReset}>↺</Button>
		</div>
		<!--
			Mode is a switch showing CURRENT STATE, not a command: both options are
			always visible with stable labels, and the active one is pressed. The
			previous single button flipped its own label AND its pressed state on
			click, so it read as a command to some people and a state to others.
		-->
		<div class="mode" role="group" aria-label="Timer mode">
			<Button
				pressed={object.payload.mode === 'countdown'}
				onpointerdown={stopPointer}
				onclick={() => {
					setMode('countdown');
				}}>↓ count</Button
			>
			<Button
				pressed={object.payload.mode === 'countup'}
				onpointerdown={stopPointer}
				onclick={() => {
					setMode('countup');
				}}>↑ count</Button
			>
		</div>
		{#if object.payload.mode === 'countdown'}
			<div class="config">
				<Button
					label="Subtract one minute"
					onpointerdown={stopPointer}
					onclick={() => {
						adjustDuration(-60_000);
					}}>−1m</Button
				>
				<Button
					label="Add one minute"
					onpointerdown={stopPointer}
					onclick={() => {
						adjustDuration(60_000);
					}}>+1m</Button
				>
			</div>
		{/if}
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
	/* Layout only — every button's own appearance comes from Button.svelte. */
	.controls,
	.mode,
	.config {
		display: flex;
		gap: var(--space-1);
		flex-wrap: wrap;
		justify-content: center;
	}
</style>
