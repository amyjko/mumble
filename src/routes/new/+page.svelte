<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Button from '$lib/ui/Button.svelte';
	import { canonicalRoomName, roomNameMessage, roomNameProblem } from '$lib/model/room-name';

	/**
	 * Making a room (UX-ROOM-8/9).
	 *
	 * Its own route rather than a form on the landing page, because this is the
	 * step that will sit behind account creation: once auth exists (AR-AUTH-1),
	 * an unauthenticated visitor gets redirected from HERE to sign-up and
	 * returns to finish naming their room. A form embedded in the landing page
	 * would have no seam to redirect at.
	 *
	 * Nothing is gated today — the guard belongs with the auth it depends on,
	 * not stubbed ahead of it (see canDesignRoom for what a stubbed gate that
	 * admits nobody costs).
	 */

	let room = $state('');
	const problem = $derived(room === '' ? null : roomNameProblem(room));
	const valid = $derived(room !== '' && problem === null);

	function go(event: SubmitEvent): void {
		event.preventDefault();
		if (valid) void goto(resolve('/hey/[room]', { room: canonicalRoomName(room) }));
	}
</script>

<svelte:head>
	<title>Make a room · mumble</title>
</svelte:head>

<main>
	<h1>Make a room</h1>
	<p class="lede">Pick a name. The name is the address, so it is worth choosing one you can say out loud.</p>
	<form onsubmit={go}>
		<span class="prefix">mumble.studio/hey/</span>
		<input
			bind:value={room}
			placeholder="room-name"
			aria-label="Room name"
			aria-invalid={problem !== null}
			aria-describedby={problem === null ? undefined : 'room-name-problem'}
		/>
		<Button type="submit" variant="primary" disabled={!valid}>go</Button>
	</form>
	{#if problem !== null}
		<!-- Say which rule was broken. A disabled button with no explanation
		     leaves you guessing whether the name is malformed or taken. -->
		<p id="room-name-problem" class="problem" role="alert">{roomNameMessage(problem)}</p>
	{/if}
	<p class="back"><a href={resolve('/')}>Back</a></p>
</main>

<style>
	main {
		max-width: 460px;
		margin: 18vh auto 0;
		font: var(--text-lg) / var(--leading) var(--font-ui);
		color: var(--text);
		padding: 0 var(--space-4);
	}
	.lede {
		color: var(--text-muted);
		font-size: var(--text-md);
	}
	.problem {
		color: var(--danger);
		font-size: var(--text-sm);
	}
	form {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.prefix {
		color: var(--text-muted);
	}
	input {
		flex: 1;
		padding: var(--space-2) var(--space-2);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		font: inherit;
	}
	.back {
		margin-top: var(--space-6);
		font-size: var(--text-sm);
	}
	.back a {
		color: var(--text-muted);
	}
</style>
