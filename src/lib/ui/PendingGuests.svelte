<script lang="ts">
	import { onDestroy } from 'svelte';
	import { supabaseBrowser } from '$lib/auth/browser-client';
	import type { RealtimeChannel } from '@supabase/supabase-js';
	import { z } from 'zod';
	import Button from './Button.svelte';
	import Emoji from './Emoji.svelte';
	import { suggestedEmoji } from '$lib/model/identity';

	/**
	 * Who is at the door (UX-ID-3).
	 *
	 * Hosts only. A guest waiting in `pending` is invisible to the canvas — they
	 * hold no participant row and every state table refuses them — so without
	 * this they would wait unseen, which is the failure mode that makes a door
	 * worse than no door.
	 *
	 * Read directly from `room_members` rather than through the room store: the
	 * pending set is membership, not room state, and it is deliberately NOT in
	 * the layout or the CRDT. Hosts can read the table under RLS
	 * (`room_members_select` is status-agnostic); nobody can write it.
	 */

	interface Props {
		roomId: string;
		roomName: string;
	}

	let { roomId, roomName }: Props = $props();

	const memberSchema = z.object({ identity_id: z.string(), hello: z.string().nullable() });
	const profileSchema = z.object({ id: z.string(), name: z.string(), emoji: z.string() });
	interface Guest {
		id: string;
		hello: string | null;
		name: string;
		emoji: string;
	}

	let guests = $state<Guest[]>([]);
	let busy = $state<string | null>(null);
	let problem = $state('');
	let channel: RealtimeChannel | null = null;

	async function refresh(): Promise<void> {
		const db = supabaseBrowser();
		const { data: rows } = await db
			.from('room_members')
			.select('identity_id, hello')
			.eq('room_id', roomId)
			.eq('status', 'pending');
		const members = z.array(memberSchema).safeParse(rows ?? []);
		if (!members.success || members.data.length === 0) {
			guests = [];
			return;
		}

		/*
		 * Two queries rather than one embed.
		 *
		 * PostgREST can only embed across a declared relationship, and there is
		 * none between `room_members` and `profiles`: both reference
		 * `auth.users`, which does not relate them to each other. Adding a
		 * foreign key to make the embed work would be the tail wagging the dog —
		 * it would also make a membership row impossible for anyone without a
		 * profile, which is a real state (the profile is written on first
		 * sign-in, and this row can be written in the same breath).
		 */
		const ids = members.data.map((m) => m.identity_id);
		const { data: people } = await db.from('profiles').select('id, name, emoji').in('id', ids);
		const profiles = z.array(profileSchema).safeParse(people ?? []);
		const byId = new Map(
			(profiles.success ? profiles.data : []).map((p) => [p.id, p])
		);

		guests = members.data.map((m) => {
			const profile = byId.get(m.identity_id);
			return {
				id: m.identity_id,
				hello: m.hello,
				// A guest with no profile row yet is still at the door and must
				// still be admittable; they are simply unnamed.
				name: profile?.name ?? 'Someone',
				// A guest with no profile row is still admittable; they are simply
				// unnamed, and the fallback face keeps the row from collapsing.
				emoji: profile?.emoji ?? suggestedEmoji()
			};
		});
	}

	$effect(() => {
		void refresh();
		// A knock is announced by the DATABASE on `door:<room>`, not by the guest
		// — a pending guest holds no write privilege on the room's channels, and
		// giving them one to ring a bell would be a hole. The ping carries no
		// payload: this re-reads the table under RLS instead, so a waiting
		// guest's name and note never ride a channel that every admitted member
		// can read. Polling was the alternative, and it is either slow to notice
		// someone waiting or constant noise in a room where nobody ever knocks.
		const active = supabaseBrowser().channel(`door:${roomId}`, { config: { private: true } });
		active.on('broadcast', { event: 'knock' }, () => {
			void refresh();
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

	async function decide(guest: string, decision: 'admit' | 'decline'): Promise<void> {
		busy = guest;
		problem = '';
		const response = await fetch(`/api/rooms/${roomName}/admission`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ guest, decision })
		});
		busy = null;
		if (!response.ok) {
			const body: unknown = await response.json().catch(() => null);
			const message = z.object({ message: z.string() }).safeParse(body);
			// Surfaced rather than swallowed: the two ways this fails — the room
			// filled up (UX-STAGE-11) and the guest stopped waiting — are both
			// things the host needs to be told, not left guessing at.
			problem = message.success ? message.data.message : 'That did not work';
		}
		await refresh();
	}
</script>

{#if guests.length > 0 || problem !== ''}
	<section aria-label="Waiting to be let in">
		<h3>At the door ({guests.length})</h3>
		{#if problem !== ''}
			<p class="problem" role="alert">{problem}</p>
		{/if}
		<ul>
			{#each guests as guest (guest.id)}
				<li>
					<span class="who"><Emoji glyph={guest.emoji} /> {guest.name}</span>
					{#if guest.hello !== null && guest.hello !== ''}
						<span class="hello">{guest.hello}</span>
					{/if}
					<span class="actions">
						<Button
							disabled={busy === guest.id}
							onclick={() => void decide(guest.id, 'admit')}>Admit</Button
						>
						<Button
							disabled={busy === guest.id}
							onclick={() => void decide(guest.id, 'decline')}>Decline</Button
						>
					</span>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	section {
		border-top: 1px solid var(--border);
		margin-top: var(--space-3);
		padding-top: var(--space-3);
	}
	h3 {
		margin: 0 0 var(--space-2);
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-2);
	}
	li {
		display: grid;
		gap: 2px;
	}
	.hello {
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.actions {
		display: flex;
		gap: var(--space-1);
		margin-top: 2px;
	}
	.problem {
		color: var(--danger);
		font-size: var(--text-sm);
	}
</style>
