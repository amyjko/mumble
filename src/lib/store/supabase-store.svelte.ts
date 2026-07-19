import type { RealtimeChannel } from '@supabase/supabase-js';
import type { EphemeralMessage, Mutation, RoomState } from '$lib/model/types';
import type { RoomStore } from './room-store';
import { StoreRejection } from '$lib/model/types';
import { ephemeralSchema, roomStateSchema, mutationSchema } from '$lib/model/schemas';
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
	async commit(mutation: Mutation): Promise<void> {
		const parsed = mutationSchema.safeParse(mutation);
		if (!parsed.success) throw new StoreRejection('invalid', 'Malformed mutation');

		const response = await fetch(`/api/rooms/${this.roomName}/mutate`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(parsed.data)
		});

		if (!response.ok) {
			const reason =
				response.status === 403 ? 'permission' : response.status === 409 ? 'overlap' : 'invalid';
			const body: unknown = await response.json().catch(() => null);
			const message = z_error.safeParse(body);
			throw new StoreRejection(reason, message.success ? message.data.message : 'Change rejected');
		}
		// Re-read rather than trusting a local copy: the server may have adjusted
		// the result (the solver slides a drag to contact), and the settled state
		// is whatever it wrote.
		await this.hydrate();
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
