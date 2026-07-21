<script lang="ts">
	import type { RoomStore } from '$lib/store/room-store';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import type { StoredIdentity } from '$lib/model/types';
	import type { Viewport } from './viewport.svelte';
	import EmoteBar from './EmoteBar.svelte';
	import ThemeToggle from '$lib/ui/ThemeToggle.svelte';
	import Button from '$lib/ui/Button.svelte';
	import { roomBudget } from './budget.svelte';

	/**
	 * The one bottom toolbar.
	 *
	 * There were three floating clusters competing for the bottom of the
	 * screen: the emote bar fixed at bottom-centre, the camera cluster absolute
	 * at bottom-right, and the theme toggle fixed at bottom-left. At most
	 * window sizes they overlapped, and the emote bar — which wraps — grew
	 * straight over the other two.
	 *
	 * One bar, one row, one surface. It wraps as a whole, so growing content
	 * pushes rather than covers. This is the chrome layer ThemeToggle's comment
	 * has been waiting for.
	 */

	interface Props {
		store: RoomStore;
		sync: SyncClient;
		identity: StoredIdentity;
		viewport: Viewport;
		/** Passed through to EmoteBar; the picker must open from its click. */
		onShareScreen?: (() => void) | undefined;
		onStopScreenShare?: (() => void) | undefined;
	}

	let { store, sync, identity, viewport, onShareScreen, onStopScreenShare }: Props = $props();

	const zoomPercent = $derived(Math.round(viewport.camera.scale * 100));
	/** Within a percent of 1:1 — a readout of "100%" that is not quite 1:1 reads as broken. */
	const atActualSize = $derived(Math.abs(viewport.camera.scale - 1) < 0.005);

	/**
	 * The room's remaining weekly time (UX-ECON-2), reported by the heartbeat.
	 *
	 * HERE rather than inside EmoteBar, though it renders in the same bar: that
	 * group is labelled "Express yourself" and can only ever act on you, and a
	 * budget readout is neither. Putting it there would have quietly widened what
	 * that group claims to be.
	 *
	 * Read from a module rather than taken as a prop, because it would otherwise
	 * need threading through the room page and Room, neither of which has any use
	 * for it (`deferredWork` is a module for the same reason).
	 */
	const budget = $derived(roomBudget.readout);

	/** The reset moment in the viewer's own locale and zone, as OutOfTime does. */
	const resetsWhen = $derived.by(() => {
		const iso = roomBudget.resetsAt;
		if (iso === null) return null;
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) return null;
		return new Intl.DateTimeFormat(undefined, {
			weekday: 'long',
			hour: 'numeric',
			minute: '2-digit'
		}).format(date);
	});

	/**
	 * What running out actually means, spelled out rather than implied.
	 *
	 * The consequence is deliberately specific, because the gate is specific and
	 * a vaguer warning reads as worse than it is: running out closes the room to
	 * NEW ARRIVALS only (AR-COST-4). Nobody is dropped from a meeting under way,
	 * and saying so is the difference between a limit people can plan around and
	 * one they think might cut them off mid-sentence.
	 */
	const explanation = $derived.by(() => {
		if (budget === null) return '';
		const when = resetsWhen === null ? 'the week resets' : resetsWhen;
		const stay = 'Everyone already here can stay.';
		if (budget.exhausted) {
			return `This room has used its meeting time for the week. Nobody new can join until ${when}. ${stay}`;
		}
		return `Meeting time left in this room's weekly budget. When it runs out, nobody new can join until ${when}. ${stay}`;
	});
</script>

<div class="bottom-bar panel">
	<ThemeToggle inline />

	<span class="divider" aria-hidden="true"></span>

	<EmoteBar {store} {sync} {identity} {onShareScreen} {onStopScreenShare} />

	<span class="divider" aria-hidden="true"></span>

	<div class="camera">
		<!--
			Auto-fit is content-relative, so one small note zooms in until text is
			huge and a sprawling room zooms out past readable. Actual size is the
			way back to what everything was designed at; before this the only
			route was nudging +/- until the readout happened to say 100%.
		-->
		<Button
			pressed={atActualSize}
			label="Zoom to actual size (100%)"
			onclick={() => {
				viewport.resetZoom();
			}}>{zoomPercent}%</Button
		>
		<Button
			pressed={viewport.autoZoom}
			label="Auto-fit the room in view, currently {viewport.autoZoom ? 'on' : 'off'}"
			onclick={() => (viewport.autoZoom = !viewport.autoZoom)}
		>
			⤢ fit
		</Button>
	</div>

	<!--
		The room's remaining time this week (UX-ECON-2).

		A footnote, not a control: it is the only thing in this bar nobody can
		click. Absent entirely until the first heartbeat answers, because a
		placeholder reading as a full week is worse than nothing for exactly the
		rooms this exists to warn.

		`aria-live="polite"` so crossing under an hour is ANNOUNCED rather than
		only coloured — a warning carried by colour alone reaches nobody who
		cannot see it, and this one has a consequence attached. Polite, not
		assertive: it should not interrupt speech for something that is not urgent
		until it is.
	-->
	{#if budget !== null}
		<span class="budget" class:warning={budget.warning} aria-live="polite" title={explanation}>
			{budget.label}
		</span>
	{/if}
</div>

<style>
	.bottom-bar {
		position: fixed;
		bottom: var(--space-3);
		left: 50%;
		translate: -50% 0;
		z-index: var(--z-chrome);
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: center;
		gap: var(--space-2);
		max-width: calc(100vw - 2 * var(--space-3));
		padding: var(--space-1) var(--space-2);
	}
	.camera {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}
	.divider {
		width: 1px;
		align-self: stretch;
		background: var(--border);
	}
	/*
	 * A footnote: smaller and muted, so it reads as an annotation on the bar
	 * rather than a control in it. `cursor: help` matches the title attribute —
	 * this is the one element here that does nothing when clicked, and it should
	 * not look like it might.
	 *
	 * `flex-basis: 100%` puts it on its own line beneath the controls, which is
	 * what makes it read as a footnote rather than as another item in the row.
	 */
	.budget {
		flex-basis: 100%;
		text-align: center;
		font-size: var(--text-xs);
		color: var(--text-muted);
		white-space: nowrap;
	 	cursor: help;
	}
	/*
	 * Under an hour. --danger against --surface is contrast-checked in both
	 * themes (theme-contrast.spec.ts), which is why the warning is a token
	 * rather than a hand-picked amber.
	 *
	 * Colour is NOT the only signal: the label changes unit at the same moment
	 * (hours to minutes) and the text is announced through aria-live. WCAG 1.4.1.
	 */
	.budget.warning {
		color: var(--danger);
		font-weight: 600;
	}
</style>
