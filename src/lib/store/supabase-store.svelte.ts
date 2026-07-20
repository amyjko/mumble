import { untrack } from 'svelte';
import { REALTIME_SUBSCRIBE_STATES, type RealtimeChannel } from '@supabase/supabase-js';
import type { EphemeralMessage, Mutation, RoomState } from '$lib/model/types';
import type { RoomStore } from './room-store';
import { StoreRejection } from '$lib/model/types';
import { ephemeralSchema, roomStateSchema, mutationSchema, freshRoomState } from '$lib/model/schemas';
import { applyMutation } from '$lib/model/rules';
import { z } from 'zod';
import { supabaseBrowser } from '$lib/auth/browser-client';

/** Wire shapes, parsed at the boundary — `as` is banned, and rightly here. */
const z_envelope = z.object({ version: z.number(), state: z.unknown() });
const z_version = z.object({ version: z.number(), by: z.string().nullish() });
/** What a tab announces about itself. Parsed like any other peer message. */
const z_presence = z.object({ actor: z.string() });
const z_ok = z.object({ version: z.number() });
const z_error = z.object({ message: z.string() });
import { docFromEncoded, mergeEncoded, noteText } from '$lib/model/ydoc';

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
	return freshRoomState();
}


export class SupabaseRoomStore implements RoomStore {
	state = $state<RoomState>(emptyState());

	/**
	 * This TAB. Sent with every write and echoed in the broadcast, so this store
	 * can tell its own change from a peer's — two tabs of one person are two
	 * clients, so the actor id could not do this job.
	 */
	private readonly clientId = crypto.randomUUID();
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
	/**
	 * True once the room has been read at least once.
	 *
	 * The canvas waits for this before it may commit anything. Without it the
	 * FIRST read raced the join commit: the read was issued against an empty
	 * room, returned after the participant had been applied optimistically, and
	 * replaced it — the room rendered with no avatar at all, and nothing
	 * re-read, because a commit's own echo is deliberately suppressed.
	 *
	 * Only the first read has this problem; later ones carry a version that
	 * settles the ordering. So this is a one-time gate rather than a rule about
	 * every snapshot, which is what an earlier attempt made it — and that
	 * starved peer updates completely while anyone was typing.
	 */
	ready = $state(false);
	/**
	 * Commits sent but not yet confirmed.
	 *
	 * Exposed so a test can wait for writes to LAND rather than sleep and hope.
	 * Several E2E tests used a fixed `waitForTimeout` as a stand-in for "the
	 * commit has been persisted", which was a fair bet against an in-memory
	 * store and is a coin toss against a network — and a lost toss there does
	 * not merely fail late, it writes the wrong value and fails permanently.
	 * Mirrored onto the document by the room page, next to `data-hydrated`.
	 */
	pending = $state(0);
	/**
	 * Who is actually CONNECTED right now, by actor id.
	 *
	 * Distinct from `state.participants`, which is a row that outlives the tab
	 * that wrote it. A participant row says "this person joined"; presence says
	 * "this person is here", and the difference is a closed laptop.
	 *
	 * Two things need it. AR-CTRL-3's >=2-present rule wants people PRESENT, not
	 * rows — a room with fifty rows and one live tab is a lone occupant. And a
	 * holder who vanishes has to be reaped, or at `max_av = 1` their slot is the
	 * conch and the room is silent until someone restarts it.
	 */
	present = $state<string[]>([]);
	// Subscription plumbing, never rendered — same reason as `handlers` above.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- see above
	private readonly leaveHandlers = new Set<(actorId: string) => void>();
	/**
	 * Applied locally, not yet confirmed by the server.
	 *
	 * A snapshot fetched while one of these is in flight does not contain it —
	 * the read was issued before the write landed — so applying that snapshot
	 * raw silently discards work the user has already seen happen. They are
	 * re-applied on top of every snapshot instead; see `hydrate`.
	 */
	private unconfirmed: Mutation[] = [];

	constructor(roomId: string, roomName: string) {
		this.roomId = roomId;
		this.roomName = roomName;
		// Deliberately does NOT read or subscribe yet — see `setActor`.
	}

	/** Set once the actor is known, so the room is read exactly once. */
	private started = false;

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

		/*
		 * Drop a snapshot that is not NEWER than what we hold.
		 *
		 * The broadcast handler already refuses stale versions, but the hydrate
		 * RESPONSE can be stale on its own: a read issued before a local commit
		 * lands returns afterwards, and assigning it unconditionally replaced
		 * newer local state with an older server snapshot. It looked like a
		 * rendering glitch and behaved like a data race — create a note, then a
		 * timer immediately, and the timer's `maxZOf` saw an empty room, so both
		 * objects were born at z=1 and stacking order became arbitrary. Waiting a
		 * couple of seconds between them "fixed" it, which is the signature.
		 *
		 * Equal versions are dropped too: we already applied that write locally,
		 * and re-assigning it would discard whatever has been typed since.
		 */
		if (envelope.data.version <= this.version) return;

		this.version = envelope.data.version;
		this.state = incoming;

		/*
		 * Put unconfirmed local writes BACK on top.
		 *
		 * This is the bug that made the E2E suite flaky for days, and the trace
		 * of a failure shows it exactly: a broadcast triggers a hydrate WHILE a
		 * commit is still in flight, so `version` has not caught up, the guard
		 * above passes, and a snapshot taken before that write replaces state
		 * that already contained it. The object vanishes and never comes back,
		 * because a commit's own echo is deliberately suppressed — so nothing
		 * further re-reads. Create a note and do anything else immediately, and
		 * the note is simply gone.
		 *
		 * The earlier attempt at this dropped the snapshot whenever anything was
		 * in flight. That starved peer updates completely while anyone was
		 * typing, because typing means something is always in flight. Re-applying
		 * is the version that keeps both properties: the peer's change lands, and
		 * so does the local one the server has not answered for yet.
		 *
		 * Rejections are ignored on purpose. The server is the authority, and a
		 * write it is about to refuse (an overlap, a lost slot) should not be
		 * forced back into view here — the commit's own failure path re-reads and
		 * shows the revert (UX-PERM-4).
		 */
		for (const mutation of this.unconfirmed) {
			try {
				untrack(() => {
					applyMutation(this.state, mutation, { actorId: this.actorId, isHost: this.isHost });
				});
			} catch {
				// Refused against the settled state; the server's answer wins.
			}
		}
	}

	private subscribe(): void {
		const channel = supabaseBrowser().channel(`room:${this.roomId}`, {
			// PRIVATE, so `room_channel_read`/`room_channel_write` on
			// realtime.messages are actually consulted — Supabase checks RLS only
			// for private channels, and the policy commented as "the room gate"
			// was inert while this defaulted to public. Measured before the fix: a
			// never-signed-in client subscribed to a room it had no membership in
			// and injected an emote that a member rendered.
			config: { private: true, broadcast: { self: false } }
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

			/*
			 * Our OWN write, already applied locally: record the version and do
			 * not re-read.
			 *
			 * Adopting the version from the commit's HTTP response was supposed
			 * to do this, and does not — the broadcast beats the response back,
			 * so `version` is still stale here. Measured before this: six writes
			 * produced six full re-reads by the client that made them, each one
			 * replacing the entire object graph, re-running auto-fit and moving
			 * the canvas under whatever pointer was mid-gesture.
			 */
			if (version.data.by === this.clientId) {
				this.version = version.data.version;
				return;
			}

			void this.hydrate();
		});

		channel.on('broadcast', { event: 'ephemeral' }, (message) => {
			const parsed = ephemeralSchema.safeParse(message['payload']);
			// Same discipline as the stub's envelope guard: a malformed message
			// from a peer is dropped, never applied.
			if (!parsed.success) return;
			for (const handler of this.handlers) handler(parsed.data);
		});

		/*
		 * Presence (AR-CTRL-3, and the ghost-holder fix).
		 *
		 * Realtime already knows when a socket drops — that is what a WebSocket
		 * is for — so liveness needs no heartbeat table and no polling. `sync`
		 * carries the whole set, `leave` names who went.
		 *
		 * Keyed by ACTOR id, not by this tab's client id: two tabs of one person
		 * are one present person, and reaping on the first tab's close would
		 * take the slot from a person still sitting in the room.
		 */
		channel.on('presence', { event: 'sync' }, () => {
			this.present = this.readPresence(channel);
		});
		channel.on('presence', { event: 'leave' }, () => {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, not state
			const before = new Set(this.present);
			const after = this.readPresence(channel);
			this.present = after;
			// Announce only actors with NO remaining tab, which is what `after`
			// already accounts for.
			for (const actorId of before) {
				if (after.includes(actorId)) continue;
				for (const handler of this.leaveHandlers) handler(actorId);
			}
		});

		void channel.subscribe((status) => {
			// Announce ourselves only once the channel is actually joined —
			// tracking before that is dropped, and this tab would then be absent
			// from its own presence set.
			if (status !== REALTIME_SUBSCRIBE_STATES.SUBSCRIBED || this.actorId === '') return;
			void channel.track({ actor: this.actorId });
		});
		this.channel = channel;
	}

	/** The distinct actors currently on the channel, however many tabs each has. */
	private readPresence(channel: RealtimeChannel): string[] {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, not state
		const seen = new Set<string>();
		for (const entries of Object.values(channel.presenceState())) {
			for (const entry of entries) {
				const parsed = z_presence.safeParse(entry);
				if (parsed.success) seen.add(parsed.data.actor);
			}
		}
		return [...seen];
	}

	/** Fires when an actor's LAST tab goes. Returns an unsubscriber. */
	onPresenceLeave(handler: (actorId: string) => void): () => void {
		this.leaveHandlers.add(handler);
		return () => this.leaveHandlers.delete(handler);
	}

	/**
	 * Commit through the control plane (AR-SYNC-3).
	 *
	 * Resolves on authoritative confirmation and rejects with the same
	 * StoreRejection reasons the optimistic layer already reverts on, so
	 * SyncClient is reused untouched.
	 */
	setActor(actorId: string, isHost: boolean): void {
		const changed = this.actorId !== actorId;
		this.actorId = actorId;
		this.isHost = isHost;

		/*
		 * The room is read and subscribed HERE, not in the constructor, because
		 * both depend on WHO IS ASKING.
		 *
		 * The Realtime channel is private, so joining it is authorized by RLS
		 * against `room_members` — and membership is granted by `join_room`,
		 * which resolves after the store is built. Subscribing in the constructor
		 * therefore asked before the answer could be yes, and the channel was
		 * refused with "Unauthorized: you do not have permissions to read from
		 * this Channel topic". Every peer edit then went unseen, with no error
		 * anywhere near the symptom. `get_room_state` is gated the same way.
		 *
		 * An empty actor means the session has not resolved, so there is nothing
		 * to ask on behalf of yet.
		 */
		if (actorId === '' || this.closed) return;

		// A CHANGED actor has to re-subscribe, not just be recorded. Channel
		// authorization is evaluated once at join against whoever was asking, so
		// a channel opened as the wrong identity stays wrong for its lifetime —
		// which is exactly what happened when a second tab started from a stale
		// localStorage id, subscribed as a non-member, and then silently received
		// nothing for the rest of the session.
		if (this.started) {
			if (!changed) return;
			void this.channel?.unsubscribe();
			this.channel = null;
			this.version = -1;
		}

		this.started = true;
		void this.hydrate().finally(() => {
			this.ready = true;
		});
		this.subscribe();
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
		this.pending += 1;
		this.unconfirmed.push(mutation);
		try {
			await this.post(mutation);
		} finally {
			this.pending -= 1;
			const at = this.unconfirmed.indexOf(mutation);
			if (at !== -1) this.unconfirmed.splice(at, 1);
		}
	}

	private async post(mutation: Mutation): Promise<void> {
		const response = await fetch(`/api/rooms/${this.roomName}/mutate`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-mumble-client': this.clientId },
			body: JSON.stringify(mutation)
		});

		if (response.ok) {
			/*
			 * Adopt the version the server just wrote.
			 *
			 * Our own write comes back to us as a broadcast, and without this the
			 * client re-hydrates on its OWN commit — replacing the whole state it
			 * had already applied locally. Every replacement hands the canvas new
			 * object identities, so auto-fit re-runs and the world animates: with
			 * a commit per keystroke the layout never settled, and Playwright
			 * reported "element is not stable" because it genuinely was not.
			 *
			 * Recording the version here makes that echo a no-op, since the
			 * broadcast handler drops anything at or below what we hold. A peer's
			 * write carries a HIGHER version and still hydrates, which is the
			 * whole point of the counter.
			 */
			const settled = z_ok.safeParse(await response.json().catch(() => null));
			if (settled.success && settled.data.version > this.version) {
				this.version = settled.data.version;
			}
			return;
		}

		{
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
		this.present = [];
		this.leaveHandlers.clear();
		this.handlers.clear();
		void this.channel?.unsubscribe();
		this.channel = null;
	}
}
