import { untrack } from 'svelte';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { EphemeralMessage, Mutation, RoomState } from '$lib/model/types';
import type { RoomStore } from './room-store';
import { StoreRejection } from '$lib/model/types';
import { ephemeralSchema, roomStateSchema, mutationSchema } from '$lib/model/schemas';
import { applyMutation } from '$lib/model/rules';
import { z } from 'zod';
import { supabaseBrowser } from '$lib/auth/browser-client';

/** Wire shapes, parsed at the boundary — `as` is banned, and rightly here. */
const z_envelope = z.object({ version: z.number(), state: z.unknown() });
const z_version = z.object({ version: z.number() });
const z_error = z.object({ message: z.string() });
import { docFromEncoded, mergeEncoded, noteText } from '$lib/model/ydoc';
import { freshStage } from '$lib/model/stage';
import { DEFAULT_BORDER_WIDTH } from '$lib/model/schemas';

/**
 * The seam's SECOND implementation (AR-TRANSPORT-10's idiom, room-store.ts).
 *
 * Same interface as MemoryRoomStore, so no consumer changes and none of them
 * names a backend. What differs is where authority lives: this store holds NO
 * write path of its own. Every mutation is a POST to the control plane, which
 * runs the same rule engine with an identity it verified — the client's own
 * `applyMutation` call would be advisory, so it does not make one.
 *
 * Reads come straight from Postgres under RLS, which is what makes a hidden
 * object (UX-ROOM-3) genuinely absent rather than filtered in the browser.
 */

function emptyState(): RoomState {
	return {
		objects: {},
		participants: {},
		background: '',
		title: '',
		description: '',
		create_permission: 'all',
		border_default: DEFAULT_BORDER_WIDTH,
		...freshStage(),
		transport: 'p2p',
		participant_locations: {},
		placers: [],
		configurations: {},
		active_config: null
	};
}

export class SupabaseRoomStore implements RoomStore {
	state = $state<RoomState>(emptyState());

	private readonly roomId: string;
	private readonly roomName: string;
	private channel: RealtimeChannel | null = null;
	private version = -1;
	private closed = false;
	// Subscription plumbing, never rendered. Making it reactive (SvelteSet)
	// crashes with state_unsafe_mutation for the same reason it does in the
	// stub: SyncClient subscribes during its own $derived construction, which
	// would then mutate another derived's state.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- see above
	private readonly handlers = new Set<(m: EphemeralMessage) => void>();

	/**
	 * Who is acting, set AFTER construction.
	 *
	 * Not a constructor argument, because the store must be built once per ROOM
	 * and the identity resolves later (anonymous sign-in, then the join RPC,
	 * then possibly a roamed profile). Taking it up front made the store a
	 * `$derived` on identity, which rebuilt it — and its Realtime channel — every
	 * time any of those landed.
	 */
	private actorId = '';
	private isHost = false;
	/** Tail of the in-flight commit chain; see `commit`. */
	private queue: Promise<void> = Promise.resolve();

	constructor(roomId: string, roomName: string) {
		this.roomId = roomId;
		this.roomName = roomName;
		void this.hydrate();
		this.subscribe();
	}

	/**
	 * Read the whole room in one call.
	 *
	 * Merges note documents rather than replacing them. Replacing would discard
	 * whatever this client has typed since the snapshot was taken — the exact
	 * data loss the CRDT exists to prevent, and the reason the stub's
	 * cross-tab path does the same thing.
	 */
	private async hydrate(): Promise<void> {
		if (this.closed) return;
		const { data, error } = await supabaseBrowser().rpc('get_room_state', { p_room_id: this.roomId });
		if (error !== null || data === null) return;

		const envelope = z_envelope.safeParse(data);
		if (!envelope.success) return;
		const parsed = roomStateSchema.safeParse(envelope.data.state);
		if (!parsed.success) {
			console.warn('mumble: room state failed validation', parsed.error.message);
			return;
		}

		const incoming = parsed.data;
		for (const [id, object] of Object.entries(incoming.objects)) {
			if (object.type !== 'note') continue;
			const mine = this.state.objects[id];
			if (mine === undefined || mine.type !== 'note') continue;
			const merged = mergeEncoded(mine.payload.doc, object.payload.doc);
			object.payload = { doc: merged, text: noteText(docFromEncoded(merged)) };
		}

		this.version = envelope.data.version;
		this.state = incoming;
	}

	private subscribe(): void {
		const channel = supabaseBrowser().channel(`room:${this.roomId}`, {
			config: { broadcast: { self: false } }
		});

		/*
		 * The write side broadcasts a NOTIFICATION, not the state: Realtime caps
		 * messages near 256 KB and a room with a couple of drawings exceeds that,
		 * failing silently. So a change says only "there is a version N" and the
		 * client re-reads.
		 *
		 * `version <= this.version` is dropped, which makes this both idempotent
		 * and monotonic: your own commit returns over HTTP and arrives here too.
		 */
		channel.on('broadcast', { event: 'state' }, (message) => {
			const version = z_version.safeParse(message['payload']);
			if (!version.success || version.data.version <= this.version) return;
			void this.hydrate();
		});

		channel.on('broadcast', { event: 'ephemeral' }, (message) => {
			const parsed = ephemeralSchema.safeParse(message['payload']);
			// Same discipline as the stub's envelope guard: a malformed message
			// from a peer is dropped, never applied.
			if (!parsed.success) return;
			for (const handler of this.handlers) handler(parsed.data);
		});

		void channel.subscribe();
		this.channel = channel;
	}

	/**
	 * Commit through the control plane (AR-SYNC-3).
	 *
	 * Resolves on authoritative confirmation and rejects with the same
	 * StoreRejection reasons the optimistic layer already reverts on, so
	 * SyncClient is reused untouched.
	 */
	setActor(actorId: string, isHost: boolean): void {
		this.actorId = actorId;
		this.isHost = isHost;
	}

	async commit(mutation: Mutation): Promise<void> {
		const parsed = mutationSchema.safeParse(mutation);
		if (!parsed.success) throw new StoreRejection('invalid', 'Malformed mutation');

		/*
		 * Apply LOCALLY first, then send. AR-SYNC-3 permits exactly this —
		 * "client-side checks exist only for responsiveness" — and it is not
		 * optional in practice: a canvas that waits for a round trip before
		 * showing your own keystroke is unusable, and re-reading the whole room
		 * after every commit (what this did first) also destroys whatever you
		 * have typed since.
		 *
		 * The server remains the authority. A local rejection saves a pointless
		 * request; a SERVER rejection re-reads, which is the revert.
		 */
		// Only once the actor is known. Before that (the moment between mount and
		// sign-in) the server is the sole judge, which is correct anyway.
		if (this.actorId !== '') {
			// untrack, for the reason MemoryRoomStore.commit spells out and this
			// store did not honour: with no latency this runs SYNCHRONOUSLY inside
			// whatever effect triggered the commit, and applyMutation both reads
			// state (permission and collision checks) and writes it — so the
			// caller's effect ends up depending on the very state it mutates.
			//
			// That is an infinite loop, and it was one: Room's join effect commits
			// upsert_participant, so a second tab died with
			// effect_update_depth_exceeded before it ever processed a broadcast.
			// The stub's comment calls this a guarantee the seam makes "for every
			// store implementation" — it was implemented in exactly one of them,
			// which is why the rule now appears in both.
			untrack(() => {
				applyMutation(this.state, parsed.data, { actorId: this.actorId, isHost: this.isHost });
			});
		}

		/*
		 * One request at a time, per store.
		 *
		 * Typing fires a mutation per keystroke, and sending them concurrently
		 * makes a client RACE ITSELF: every guarded write carries the version it
		 * read, so the second keystroke's request is already stale when it
		 * arrives, and with a bounded retry most of them are simply dropped.
		 * Measured before this queue: `pressSequentially('Alice writes. ')` —
		 * fourteen keystrokes — reached a peer as "A".
		 *
		 * The local apply above stays synchronous and unqueued, so typing still
		 * feels instant; only the network half is ordered. Ordering it is also
		 * the honest thing for a log like `post_message`, where arrival order is
		 * the message order.
		 */
		const send = this.queue.then(
			() => this.send(parsed.data),
			() => this.send(parsed.data)
		);
		// The queue must not reject, or one failed commit would poison every
		// commit after it. The REAL outcome still reaches this caller via `send`.
		this.queue = send.then(
			() => undefined,
			() => undefined
		);
		return send;
	}

	private async send(mutation: Mutation): Promise<void> {
		const response = await fetch(`/api/rooms/${this.roomName}/mutate`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(mutation)
		});

		if (!response.ok) {
			const reason =
				response.status === 403 ? 'permission' : response.status === 409 ? 'overlap' : 'invalid';
			const body: unknown = await response.json().catch(() => null);
			const message = z_error.safeParse(body);
			// The server disagreed, so the local optimism was wrong: re-read to
			// get the settled truth back (UX-PERM-4's visible revert).
			await this.hydrate();
			throw new StoreRejection(reason, message.success ? message.data.message : 'Change rejected');
		}
	}

	sendEphemeral(message: EphemeralMessage): void {
		if (this.closed) return;
		void this.channel?.send({ type: 'broadcast', event: 'ephemeral', payload: message });
	}

	onEphemeral(handler: (message: EphemeralMessage) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	dispose(): void {
		this.closed = true;
		this.handlers.clear();
		void this.channel?.unsubscribe();
		this.channel = null;
	}
}
