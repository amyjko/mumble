<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

	let room = $state('');
	const valid = $derived(/^[a-z0-9_-]{2,32}$/i.test(room));

	function go(event: SubmitEvent): void {
		event.preventDefault();
		if (valid) void goto(resolve('/hey/[room]', { room: room.toLowerCase() }));
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
		<input bind:value={room} placeholder="room-name" aria-label="Room name" />
		<button disabled={!valid}>go</button>
	</form>
</main>

<style>
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
	button {
		min-height: var(--target-min);
		padding: var(--space-2) var(--space-4);
		border: none;
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: var(--accent-contrast);
		font: inherit;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.4;
		cursor: default;
	}
</style>
