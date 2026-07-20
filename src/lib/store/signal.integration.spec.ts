import { createClient, REALTIME_SUBSCRIBE_STATES, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY } from '$env/static/public';
import { SUPABASE_SECRET_KEY } from '$env/static/private';
import type { Database } from '$lib/database.types';

/**
 * The signalling inbox, against a real Realtime server (AR-BACKEND-2/6).
 *
 * The pgTAP suite asserts the POLICY PREDICATES; this asserts that the policies
 * are actually attached and that a message survives the trip. Those are
 * different claims, and the difference is exactly how the room channel once
 * shipped public with a correct-looking policy that was never consulted — a
 * private channel is the only kind Supabase evaluates RLS for, and a predicate
 * nobody calls proves nothing.
 *
 * Two real signed-in clients, no browser: this is the transport, not the UI.
 */

const admin: SupabaseClient<Database> = createClient<Database>(
	PUBLIC_SUPABASE_URL,
	SUPABASE_SECRET_KEY,
	{ auth: { autoRefreshToken: false, persistSession: false } }
);

/** A signed-in client for a fresh user, with Realtime authorized as them. */
async function member(): Promise<{ client: SupabaseClient<Database>; id: string }> {
	const email = `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
	const password = `pw-${Math.random().toString(36).slice(2)}`;
	const { data: created } = await admin.auth.admin.createUser({
		email,
		password,
		email_confirm: true
	});
	const client = createClient<Database>(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
		auth: { autoRefreshToken: false, persistSession: false }
	});
	const { error } = await client.auth.signInWithPassword({ email, password });
	if (error !== null) throw new Error(`could not sign in: ${error.message}`);
	// Realtime authorizes the socket from the access token, not the REST session.
	const { data: session } = await client.auth.getSession();
	await client.realtime.setAuth(session.session?.access_token ?? '');
	return { client, id: created.user?.id ?? '' };
}

/** Subscribe and resolve once actually joined, so a send cannot race the join. */
async function joined(channel: ReturnType<SupabaseClient<Database>['channel']>): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			resolve(false);
		}, 10_000);
		void channel.subscribe((status) => {
			if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
				clearTimeout(timer);
				resolve(true);
			}
			if (
				status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
				status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT
			) {
				clearTimeout(timer);
				resolve(false);
			}
		});
	});
}

let roomId = '';
let alice: { client: SupabaseClient<Database>; id: string };
let bob: { client: SupabaseClient<Database>; id: string };
let nosy: { client: SupabaseClient<Database>; id: string };

beforeAll(async () => {
	alice = await member();
	bob = await member();
	nosy = await member();

	const { data, error } = await admin
		.from('rooms')
		.insert({
			name: `sig${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
			owner_id: alice.id
		})
		.select('id')
		.single();
	if (error !== null) throw new Error(`could not create room: ${error.message}`);
	roomId = data.id;

	// All three admitted: the point is that MEMBERSHIP alone must not open
	// somebody else's inbox.
	for (const who of [bob.id, nosy.id]) {
		await admin.from('room_members').insert({
			room_id: roomId,
			identity_id: who,
			role: 'participant',
			status: 'admitted'
		});
	}
}, 60_000);

describe('the signalling inbox', () => {
	it('delivers a signal to the peer it is addressed to', async () => {
		const inbox = bob.client.channel(`signal:${roomId}:${bob.id}`, {
			config: { private: true }
		});
		const arrived = new Promise<unknown>((resolve) => {
			inbox.on('broadcast', { event: 'signal' }, (message) => {
				resolve(message['payload']);
			});
		});
		expect(await joined(inbox)).toBe(true);

		/*
		 * NOT subscribed, and that is the mechanism rather than an oversight.
		 *
		 * Joining a topic requires SELECT, which Alice deliberately does not have
		 * on Bob's inbox — that asymmetry IS the privacy. supabase-js falls back
		 * to an HTTP broadcast for a channel it has not joined, and that path is
		 * checked against the INSERT policy alone, which is exactly the permission
		 * she does have. Trying to subscribe here first is how this test failed
		 * the first time.
		 */
		const out = alice.client.channel(`signal:${roomId}:${bob.id}`, { config: { private: true } });
		await out.send({
			type: 'broadcast',
			event: 'signal',
			payload: { to: 'bob-tab', from: 'alice-tab', payload: { kind: 'bye' } }
		});

		const received = await Promise.race([
			arrived,
			new Promise((resolve) => {
				setTimeout(() => {
					resolve('TIMED OUT');
				}, 10_000);
			})
		]);
		expect(received).toEqual({ to: 'bob-tab', from: 'alice-tab', payload: { kind: 'bye' } });

		await inbox.unsubscribe();
		await out.unsubscribe();
	}, 40_000);

	it('refuses a member the topic of an inbox that is not theirs', async () => {
		/*
		 * The whole privacy claim, and the reason this is an integration test
		 * rather than only a pgTAP one. `signal_channel_read` is correct, but so
		 * was `room_channel_read` while the channel was public and it was never
		 * consulted. This asserts the policy is ATTACHED.
		 *
		 * Nosy is a fully admitted member of this room — the refusal is not about
		 * belonging, it is about whose inbox this is.
		 */
		const stolen = nosy.client.channel(`signal:${roomId}:${bob.id}`, {
			config: { private: true }
		});
		expect(await joined(stolen)).toBe(false);
		await stolen.unsubscribe();
	}, 40_000);

	it('lets a member reach their OWN inbox in the same room', async () => {
		// The control for the test above: if joining failed for everyone, the
		// refusal there would prove nothing about addressing.
		const own = nosy.client.channel(`signal:${roomId}:${nosy.id}`, { config: { private: true } });
		expect(await joined(own)).toBe(true);
		await own.unsubscribe();
	}, 40_000);
});
