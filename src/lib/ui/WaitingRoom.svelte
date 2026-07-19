<script lang="ts">
	import { onDestroy } from 'svelte';
	import { supabaseBrowser } from '$lib/auth/browser-client';
	import type { RealtimeChannel } from '@supabase/supabase-js';
	import { z } from 'zod';
	import Button from './Button.svelte';
	import Field from './Field.svelte';

	/**
	 * The door (UX-ID-3).
	 *
	 * A guest whose status is `pending` cannot be shown the room, and not merely
	 * as a courtesy: every state table's RLS requires admitted-ness, so the
	 * canvas would have nothing to render even if it were mounted. This is what
	 * they see instead.
	 *
	 * It carries the pre-admission conversation the requirement asks for —
	 * "the host may chat with the waiting guest pre-admission via a lightweight
	 * channel distinct from in-room chat". Distinct is the operative word: this
	 * rides `guest:<room>:<guest>`, a topic whose RLS admits only this guest
	 * while they are pending and the room's hosts. In-room chat is a canvas
	 * object and lives on the room channel, which a pending guest cannot join.
	 *
	 * Deliberately NOT persisted. A knock is not room state — it has no place in
	 * a layout, it should not survive the decision, and giving it a table would
	 * mean a declined guest's message outliving them.
	 */

	interface Props {
		roomId: string;
		guestId: string;
		/** What they said on the way in, echoed so they can see it was sent. */
		hello: string;
		declined: boolean;
	}

	let { roomId, guestId, hello, declined }: Props = $props();

	const messageSchema = z.object({ from: z.enum(['host', 'guest']), text: z.string().max(400) });
	type Message = z.infer<typeof messageSchema>;

	let messages = $state<Message[]>([]);
	let draft = $state('');
	let channel: RealtimeChannel | null = null;

	$effect(() => {
		const topic = `guest:${roomId}:${guestId}`;
		const active = supabaseBrowser().channel(topic, { config: { private: true } });
		active.on('broadcast', { event: 'knock' }, (message) => {
			const parsed = messageSchema.safeParse(message['payload']);
			// A malformed message from the other side is dropped, never rendered
			// — the same discipline the room store applies to its own envelope.
			if (!parsed.success) return;
			messages = [...messages, parsed.data];
		});
		void active.subscribe();
		channel = active;
		return () => {
			void active.unsubscribe();
			channel = null;
		};
	});

	onDestroy(() => {
		void channel?.unsubscribe();
	});

	function send(event: SubmitEvent): void {
		event.preventDefault();
		const text = draft.trim();
		if (text === '') return;
		const message: Message = { from: 'guest', text };
		// Shown locally as well as sent: `self: false` is not set here, but a
		// broadcast is not echoed to its sender by default, and a message that
		// vanishes on send reads as a failure.
		messages = [...messages, message];
		void channel?.send({ type: 'broadcast', event: 'knock', payload: message });
		draft = '';
	}
</script>

<main>
	{#if declined}
		<h1>Not this time</h1>
		<!-- Said plainly and without a retry button: rejoining cannot clear a
		     decline (join_room keeps the standing decision), so offering one
		     would be a door that looks open and is not. -->
		<p class="lede">A host declined this request. You can ask them for a new invite.</p>
	{:else}
		<h1>Waiting to be let in</h1>
		<p class="lede">A host has to admit you. They can see your name{hello === '' ? '' : ' and note'}.</p>

		{#if hello !== ''}
			<blockquote>{hello}</blockquote>
		{/if}

		<section aria-label="Messages with the host">
			<ul>
				{#each messages as message, i (i)}
					<li class:mine={message.from === 'guest'}>
						<span class="who">{message.from === 'guest' ? 'You' : 'Host'}</span>
						{message.text}
					</li>
				{/each}
			</ul>
			<form onsubmit={send}>
				<Field label="Message the host" bind:value={draft} placeholder="Say something" />
				<Button type="submit" disabled={draft.trim() === ''}>Send</Button>
			</form>
		</section>
	{/if}
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
	blockquote {
		margin: 0 0 var(--space-4);
		padding-left: var(--space-3);
		border-left: 2px solid var(--border);
		color: var(--text-muted);
	}
	ul {
		list-style: none;
		margin: 0 0 var(--space-3);
		padding: 0;
		display: grid;
		gap: var(--space-2);
	}
	.who {
		color: var(--text-muted);
		font-size: var(--text-sm);
		margin-right: var(--space-1);
	}
	li.mine .who {
		color: var(--accent);
	}
	form {
		display: flex;
		align-items: end;
		gap: var(--space-2);
	}
</style>
