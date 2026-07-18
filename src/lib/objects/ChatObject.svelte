<script lang="ts">
	import type { ChatCanvasObject, StoredIdentity } from '$lib/model/types';
	import type { SyncClient } from '$lib/store/sync-client.svelte';
	import { nowIso } from '$lib/model/types';
	import Button from '$lib/ui/Button.svelte';
	import { stopPointer } from '$lib/ui/events';

	interface Props {
		object: ChatCanvasObject;
		sync: SyncClient;
		identity: StoredIdentity;
		/** Escape returns focus to the frame (no keyboard trap — 2.1.2). */
		onexit: () => void;
	}

	let { object, sync, identity, onexit }: Props = $props();

	let draft = $state('');
	let log = $state<HTMLElement | null>(null);

	// Keep the newest message in view as the log grows.
	$effect(() => {
		void object.payload.messages.length;
		if (log) log.scrollTop = log.scrollHeight;
	});

	function send(): void {
		const text = draft.trim();
		if (text === '') return;
		void sync.commit({
			kind: 'post_message',
			id: object.id,
			message: {
				id: crypto.randomUUID(),
				author_id: identity.id,
				author_name: identity.name,
				text,
				at: nowIso()
			}
		});
		draft = '';
	}

	function onKeyDown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			send();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			onexit();
		}
	}
</script>

<div class="chat">
	<ul class="log" bind:this={log} aria-label="Chat messages">
		{#each object.payload.messages as message (message.id)}
			<li class:mine={message.author_id === identity.id}>
				<span class="who">{message.author_name}</span>
				<span class="text">{message.text}</span>
			</li>
		{/each}
	</ul>
	<div class="compose">
		<input
			data-editable
			class="entry"
			aria-label="Message"
			placeholder="Say something…"
			bind:value={draft}
			onkeydown={onKeyDown}
			onpointerdown={(e) => {
				e.stopPropagation();
			}}
		/>
		<!--
			Disabled on an empty draft. It used to stay enabled and silently
			early-return, which reads as a broken button rather than a guarded one.
		-->
		<Button
			variant="primary"
			label="Send message"
			disabled={draft.trim() === ''}
			onpointerdown={stopPointer}
			onclick={send}>Send</Button
		>
	</div>
</div>

<style>
	.chat {
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		background: var(--surface);
		color: var(--text);
	}
	.log {
		flex: 1;
		margin: 0;
		padding: var(--space-2);
		list-style: none;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		font-size: var(--text-sm);
	}
	.log li {
		display: flex;
		flex-direction: column;
	}
	.who {
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	.log li.mine .who {
		color: var(--accent);
	}
	.text {
		overflow-wrap: anywhere;
	}
	.compose {
		display: flex;
		gap: var(--space-1);
		padding: var(--space-1);
		border-top: 1px solid var(--border);
	}
	.entry {
		flex: 1;
		min-height: var(--target-min);
		padding: 0 var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		color: var(--text);
		font: var(--text-sm) var(--font-ui);
	}
</style>
