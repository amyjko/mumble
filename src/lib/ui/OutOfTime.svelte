<script lang="ts">
	/**
	 * The room has used its week (UX-ECON-2, AR-COST-4).
	 *
	 * Shown INSTEAD of the join prompt, and that ordering is the whole design of
	 * this screen: asking somebody to choose a name and an avatar and then
	 * refusing them is a worse experience than refusing them first. The
	 * authoritative gate is still the mutation route — this is what makes its 402
	 * legible rather than what enforces it.
	 *
	 * It says WHEN, because `week_resets_at` makes a real date available and a
	 * refusal that cannot say when it lifts reads as a fault rather than a limit.
	 * "Try again later" is what a broken server says.
	 *
	 * It does NOT say whose budget it was, how much was used, or who used it. The
	 * person at the door is often a guest who has no relationship with the
	 * owner's account, and a room's usage is not theirs to see — the same reason
	 * `usage_ledger` has no client read policy at all.
	 */

	interface Props {
		/** ISO timestamp from `accounts.week_resets_at`; null if it could not be read. */
		resetsAt: string | null;
	}

	let { resetsAt }: Props = $props();

	/**
	 * The date, in the reader's locale and time zone.
	 *
	 * Undefined locale on purpose: the browser's own preference is better than
	 * anything this component could guess, and a time budget that resets "Monday"
	 * resets at a different local moment for each person in the room.
	 */
	const when = $derived.by(() => {
		if (resetsAt === null) return null;
		const date = new Date(resetsAt);
		if (Number.isNaN(date.getTime())) return null;
		return new Intl.DateTimeFormat(undefined, {
			weekday: 'long',
			hour: 'numeric',
			minute: '2-digit'
		}).format(date);
	});
</script>

<main>
	<h1>This room is out of time</h1>
	<!--
		"Its host has used" rather than "it has used", and the difference is not
		pedantry: the budget belongs to the OWNER's account and is shared across
		every room they run (AR-COST-2), so this room may well have spent none of
		it. Saying the room used it up would send a host looking for activity in
		the wrong place.
	-->
	<p class="lede">
		{#if when === null}
			Its host has used their meeting time for the week. It opens again when the week
			resets.
		{:else}
			Its host has used their meeting time for the week. It opens again {when}.
		{/if}
	</p>
	<!--
		No retry button, for the reason WaitingRoom gives for not offering one on a
		decline: nothing the person at the door can do changes the answer, and a
		button that reloads into the same refusal is a door that looks open.
	-->
	<p class="quiet">Every host gets a fresh time budget each week.</p>
</main>

<style>
	main {
		max-width: 46ch;
		margin: 14vh auto 0;
		padding: 0 var(--space-4);
		font: var(--text-md) / var(--leading) var(--font-ui);
		color: var(--text);
	}
	h1 {
		font-size: var(--text-xl);
		margin: 0 0 var(--space-2);
	}
	.lede {
		color: var(--text-muted);
		margin: 0 0 var(--space-4);
	}
	.quiet {
		color: var(--text-muted);
		font-size: var(--text-sm);
		margin: 0;
	}
</style>
