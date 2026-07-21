<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import Button from '$lib/ui/Button.svelte';
	import Field from '$lib/ui/Field.svelte';
	import { budgetReadout, formatDuration } from '$lib/model/ledger';
	import type { ActionData, PageData } from './$types';

	/**
	 * Your account: what the week costs, and who you sign in as (UX-ID-10).
	 *
	 * The budget shown here is the SAME number the room toolbar shows, because
	 * there is one counter and one cap per account (AR-COST-2) — every room a
	 * person runs draws on it together. The page says so outright, since that is
	 * the fact a host with two standing meetings is most likely to get wrong, and
	 * getting it wrong means believing they have twice the time they do.
	 */
	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();
	let email = $state('');

	const budget = $derived(data.budget === null ? null : budgetReadout(data.budget.usedSeconds, data.budget.capSeconds));

	/** The reset moment in the reader's own locale and zone, as the room bar does. */
	const resetsWhen = $derived.by(() => {
		if (data.budget === null) return null;
		const date = new Date(data.budget.resetsAt);
		if (Number.isNaN(date.getTime())) return null;
		return new Intl.DateTimeFormat(undefined, {
			weekday: 'long',
			hour: 'numeric',
			minute: '2-digit'
		}).format(date);
	});
</script>

<svelte:head><title>Your account · mumble</title></svelte:head>

<main>
	<h1>Your account</h1>

	{#if data.anonymous}
		<!--
			A guest has a real account row and a full budget they can never spend,
			because rooms belong to accounts (AR-AUTH-7). Showing them "10h left"
			would be true and meaningless, so say what is actually the case.
		-->
		<p class="lede">You are here as a guest, so there is no address and no budget to show.</p>
		<p>
			Guests can do everything in a room except make one. Signing in with an email gives you
			an account, and rooms of your own.
		</p>
		<p class="cta-row"><a class="cta" href={resolve('/login')}>Sign in</a></p>
	{:else}
		<section aria-labelledby="time">
			<h2 id="time">Meeting time</h2>

			{#if budget === null || data.budget === null}
				<!-- The ledger failed to read. Saying so beats a confident zero. -->
				<p class="problem">Your budget could not be read just now. Try again in a moment.</p>
			{:else}
				<p class="figure" class:warning={budget.warning}>
					{budget.exhausted ? 'No time left this week' : `${formatDuration(budget.secondsLeft)} left this week`}
				</p>
				<dl>
					<div>
						<dt>Weekly budget</dt>
						<dd>{formatDuration(data.budget.capSeconds)}</dd>
					</div>
					<div>
						<dt>Used this week</dt>
						<dd>{formatDuration(data.budget.usedSeconds)}</dd>
					</div>
					<div>
						<dt>Resets</dt>
						<dd>{resetsWhen ?? 'when the week turns'}</dd>
					</div>
				</dl>
				<!--
					The shared-budget fact, stated rather than implied. The room
					toolbar's first wording called this "this room's budget", which
					would have told someone running two rooms they had twice the
					time — see DESIGN.md's cost open items.
				-->
				<p class="note">
					One budget covers every room you run, and it counts everyone in them — guests
					included. When it runs out, nobody new can join your rooms until it resets;
					anyone already in a room can stay.
				</p>
			{/if}
		</section>

		<section aria-labelledby="signin">
			<h2 id="signin">Sign-in address</h2>
			<p class="figure address">{data.email ?? 'unknown'}</p>

			{#if form?.sent === true}
				<!--
					Deliberately NOT "your email has been changed": the address does
					not move until a link is opened, so the address shown above is
					still the live one.

					"Either" is measured, not assumed. This first said BOTH inboxes
					had to confirm, which is what `double_confirm_changes = true`
					looks like it buys — and an E2E test following one link showed
					the change completing anyway. Two mails ARE sent (the current
					address is always told), but one confirmation finishes it; see
					the note in supabase/config.toml. Copy that overstated the
					protection would have been worse than none, because someone
					would have relied on it.
				-->
				<p class="sent" role="status">
					Check your email. A confirmation went to {form.address} and to your current
					address — opening the link in either one finishes the change. Until then you
					stay signed in as the address above.
				</p>
			{:else}
				<form method="POST" action="?/changeEmail" use:enhance>
					<Field
						label="New email"
						bind:value={email}
						type="email"
						name="email"
						autocomplete="email"
					/>
					<Button type="submit" variant="primary" disabled={!email.includes('@')}>
						Send confirmation links
					</Button>
				</form>
				{#if form?.message !== undefined}
					<p class="problem" role="alert">{form.message}</p>
				{/if}
			{/if}
		</section>
	{/if}

	<p class="back"><a href={resolve('/')}>Back</a></p>
</main>

<style>
	main {
		max-width: 460px;
		margin: 12vh auto 0;
		padding: 0 var(--space-4) var(--space-6);
		font: var(--text-md) / var(--leading) var(--font-ui);
		color: var(--text);
	}
	h1 {
		font-size: var(--text-xl);
		margin: 0 0 var(--space-4);
	}
	h2 {
		font-size: var(--text-md);
		margin: 0 0 var(--space-2);
	}
	.lede {
		color: var(--text-muted);
	}
	section {
		margin-bottom: var(--space-6);
	}
	/* The number people came for: the largest thing in its section. */
	.figure {
		font-size: var(--text-lg);
		margin: 0 0 var(--space-3);
	}
	.address {
		font-family: var(--font-mono);
		font-size: var(--text-md);
		overflow-wrap: anywhere;
	}
	/*
	 * Under an hour, matching the room toolbar exactly — the same token, the
	 * same threshold. Two surfaces disagreeing about when a budget is worth
	 * worrying about would be worse than neither warning at all.
	 */
	.figure.warning {
		color: var(--danger);
		font-weight: 600;
	}
	dl {
		margin: 0 0 var(--space-3);
		display: grid;
		gap: var(--space-1);
	}
	dl div {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		border-bottom: 1px solid var(--border);
		padding-bottom: var(--space-1);
	}
	dt {
		color: var(--text-muted);
	}
	.note {
		color: var(--text-muted);
		font-size: var(--text-sm);
		margin: 0;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		align-items: flex-start;
	}
	.sent {
		color: var(--text);
	}
	.problem {
		color: var(--danger);
		font-size: var(--text-sm);
	}
	.cta-row {
		margin: var(--space-4) 0 0;
	}
	.cta {
		display: inline-block;
		background: var(--accent);
		color: var(--accent-contrast);
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius-md);
		text-decoration: none;
	}
	.back {
		margin-top: var(--space-6);
		font-size: var(--text-sm);
	}
	.back a {
		color: var(--text-muted);
	}
</style>
