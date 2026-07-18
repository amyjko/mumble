<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Button from '$lib/ui/Button.svelte';
	import { canonicalRoomName, roomNameMessage, roomNameProblem } from '$lib/model/room-name';

	let room = $state('');
	const problem = $derived(room === '' ? null : roomNameProblem(room));
	const valid = $derived(room !== '' && problem === null);

	function go(event: SubmitEvent): void {
		event.preventDefault();
		if (valid) void goto(resolve('/hey/[room]', { room: canonicalRoomName(room) }));
	}
</script>

<svelte:head>
	<title>mumble</title>
</svelte:head>

<main>
	<h1>mumble</h1>
	<p>A playful, customizable meeting room for small groups.</p>
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
</main>

<style>
	.problem {
		color: var(--danger);
		font-size: var(--text-sm);
	}
	main {
		max-width: 460px;
		margin: 18vh auto 0;
		font: var(--text-lg) / var(--leading) var(--font-ui);
		color: var(--text);
		padding: 0 var(--space-4);
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
</style>
