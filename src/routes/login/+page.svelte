<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import Button from '$lib/ui/Button.svelte';
	import Field from '$lib/ui/Field.svelte';
	import type { ActionData, PageData } from './$types';

	/**
	 * Sign in (UX-ID-7, AR-AUTH-4).
	 *
	 * Reached by trying to make a room without an account (AR-AUTH-7). Joining
	 * a room never comes through here — that is the common case and stays
	 * anonymous, which the copy says plainly so nobody concludes they need an
	 * account to accept an invitation.
	 */
	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();
	let email = $state('');
</script>

<svelte:head><title>Sign in · mumble</title></svelte:head>

<main>
	<h1>Sign in</h1>
	<p class="lede">
		Rooms belong to an account, so making one needs an email. Joining a room never does.
	</p>

	{#if form?.sent === true}
		<!-- Same message whether or not the address has an account: anything
		     else turns this form into an account-existence oracle. -->
		<p class="sent" role="status">
			Check your email — if that address can sign in, a link is on its way.
		</p>
	{:else}
		<form method="POST" action="?/magic" use:enhance>
			<input type="hidden" name="next" value={data.next} />
			<Field label="Email" bind:value={email} type="email" name="email" autocomplete="email" />
			<Button type="submit" variant="primary" disabled={!email.includes('@')}>
				Email me a link
			</Button>
		</form>
		{#if form?.message !== undefined}
			<p class="problem" role="alert">{form.message}</p>
		{/if}

		<!--
			Nothing renders here unless the deployment configured a provider, which
			locally means nothing renders at all (see oauth-providers.ts). A button
			that cannot work is worse than an absent one on the page someone reaches
			when something else has already gone wrong.

			No `use:enhance`: this navigates off-site to the provider, so there is no
			result to apply and intercepting the submit would only get in the way.
		-->
		{#if data.providers.length > 0}
			<p class="or">or</p>
			<div class="providers">
				{#each data.providers as provider (provider.id)}
					<form method="POST" action="?/oauth">
						<input type="hidden" name="provider" value={provider.id} />
						<Button type="submit">{provider.label}</Button>
					</form>
				{/each}
			</div>
		{/if}
	{/if}

	<p class="back"><a href={resolve('/')}>Back</a></p>
</main>

<style>
	main {
		max-width: 460px;
		margin: 18vh auto 0;
		padding: 0 var(--space-4);
		font: var(--text-md) / var(--leading) var(--font-ui);
		color: var(--text);
	}
	.lede {
		color: var(--text-muted);
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
	.or {
		margin: var(--space-4) 0 var(--space-3);
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.providers {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		align-items: flex-start;
	}
	.problem {
		color: var(--danger);
		font-size: var(--text-sm);
	}
	.back {
		margin-top: var(--space-6);
		font-size: var(--text-sm);
	}
	.back a {
		color: var(--text-muted);
	}
</style>
