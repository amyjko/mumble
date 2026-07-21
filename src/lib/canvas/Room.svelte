<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { MediaSession } from '$lib/media/session.svelte';
	import { StreamCombiner } from '$lib/media/combine';
	import { P2PTransport } from '$lib/media/p2p/p2p-transport';
	import { PublishAuthorizer } from '$lib/media/p2p/authorize';
	import { mediaPublicKey } from '$lib/media/p2p/key';
	import { z } from 'zod';
	import type { StoredIdentity } from '$lib/model/types';
	import { MemoryRoomStore } from '$lib/store/memory-store.svelte';
	import type { RoomStore } from '$lib/store/room-store';
	import { AVATAR_SIZE, newParticipant } from '$lib/model/avatar';
	import { SyncClient } from '$lib/store/sync-client.svelte';
	import { Viewport } from '$lib/canvas/viewport.svelte';
	import { newNote, newTimer, newChat, newScreenshare, newImage, maxZOf } from '$lib/model/create';
	import {
		uploadImage,
		imageFilesFrom,
		ImageUploadError,
		IMAGE_BUCKET,
		SIGNED_URL_TTL_SECONDS
	} from '$lib/media/image-upload';
	import { MAX_IMAGES_PER_ROOM, shouldRefreshSignedUrl } from '$lib/model/image';
	import { BACKGROUND_GRADIENTS, BACKGROUND_LEVELS } from '$lib/model/background';
	import { DEFAULT_DRAW_COLOR } from '$lib/model/palette';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import WorldCanvas from '$lib/canvas/WorldCanvas.svelte';
	import DevPanel from '$lib/dev/DevPanel.svelte';
	import PendingGuests from '$lib/ui/PendingGuests.svelte';
	import HostSlotControls from './HostSlotControls.svelte';
	import BottomBar from '$lib/canvas/BottomBar.svelte';
	import HintBar from '$lib/canvas/HintBar.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Field from '$lib/ui/Field.svelte';
	import Popover from '$lib/ui/Popover.svelte';
	import SwatchPicker from '$lib/ui/SwatchPicker.svelte';
	import { DRAW_COLORS } from '$lib/model/palette';
	import { canonicalRoomName, roomNameMessage, roomNameProblem } from '$lib/model/room-name';
	import { wasDisplaced } from '$lib/model/placement';
	import { canDesignRoom } from '$lib/model/permissions';
	import { counts as stageCounts, type Capacity, type StageState } from '$lib/model/stage';
	import { AVATAR_EMOJI, saveIdentity } from '$lib/model/identity';
	import { saveMyProfile } from '$lib/auth/profile';
	import { supabaseBrowser } from '$lib/auth/browser-client';
	import { ADD_EMOJI } from '$lib/model/emotes';
	import EmojiPicker from '$lib/ui/EmojiPicker.svelte';
	import Emoji from '$lib/ui/Emoji.svelte';

	/**
	 * Never used: Room is only rendered with a real identity (the route gates
	 * on it). It exists because a $bindable prop needs a default, and inventing
	 * a name here would resurrect exactly what UX-ID-1 forbids — so it is
	 * deliberately unusable rather than plausible.
	 */
	const EMPTY_IDENTITY: StoredIdentity = { id: '', name: '', emoji: '' };

	interface Props {
		/** Canonical room name from the route. */
		room: string;
		/**
		 * The room's uuid. The NAME is the address and can be changed
		 * (UX-ROOM-10); the id is what membership and channels are keyed by, so
		 * anything reading room_members needs this one.
		 */
		roomId: string;
		/**
		 * Who you are. NON-NULLABLE by design: a room cannot be entered without
		 * an identity (UX-ID-1 requires a name), so the component that needs one
		 * demands it rather than defending against its absence.
		 */
		identity?: StoredIdentity | undefined;
		/**
		 * Whether you hold the host role in THIS room (UX-PERM-3). Supplied by
		 * the route from a room_members row; never inferred here, and never
		 * trusted by the server, which reads its own membership row.
		 */
		isHost?: boolean | undefined;
		/**
		 * The backend, INJECTED (AR-SYNC-3).
		 *
		 * This component used to construct `MemoryRoomStore` itself, which broke
		 * room-store.ts's own rule that no consumer may name a backend — and made
		 * the stub impossible to swap without editing the canvas. The route
		 * supplies `SupabaseRoomStore`; anything that wants the stub passes it.
		 *
		 * Constructing it here was also what made the store a `$derived` on
		 * IDENTITY: it took `identity.id`, so the store and its Realtime channel
		 * were rebuilt every time anonymous sign-in, the join RPC, or a roamed
		 * profile landed. Ownership of the lifetime belongs with whoever knows
		 * the room, not with whoever knows the actor.
		 */
		store: RoomStore;
	}

	let { room, roomId, identity = $bindable(EMPTY_IDENTITY), isHost = false, store }: Props = $props();
	const sync = $derived(new SyncClient(store));
	const viewport = new Viewport();

	// Draw mode + color are per-viewer view state (UX-OBJ-11 capture).
	let drawMode = $state(false);
	/** Measured so popovers clear the toolbar even when it wraps. */
	let barHeight = $state(0);
	let drawColor = $state(DEFAULT_DRAW_COLOR);
	let renameDraft = $state('');
	/** Drafts for the "you" editor, seeded from the current identity. */
	let nameDraft = $state(identity.name);
	let emojiDraft = $state(identity.emoji);
	const identityReady = $derived(nameDraft.trim() !== '');
	let configNameDraft = $state('');

	$effect(() => {
		const current = store;
		// Join: upsert self at the last known location, else the default spot;
		// the store resolves collisions to the nearest legal position (AR-CTRL-4's
		// shape). The participants read MUST be untracked, because the commit
		// below writes participants and a tracked read here is a
		// self-retriggering loop.
		const existing = untrack(() => current.state.participants[identity.id]);
		void sync.commit({
			kind: 'upsert_participant',
			participant: newParticipant(identity, { existing })
		});
		// NO cleanup disposing the store. This component does not own it any
		// more — the route builds it per room and disposes it. Disposing here
		// closed the Realtime channel of a LIVE store every time `identity`
		// changed, which it does moments after mount when the roamed profile
		// lands: the page then looked fine and silently received no broadcast
		// again, which is how a second tab ended up never seeing the first's
		// edits.
	});

	/*
	 * Reap a participant whose last tab went (AR-CTRL-3, UX-STAGE-4).
	 *
	 * A participant row outlives the tab that wrote it, so a closed laptop
	 * leaves someone who is "in" the room forever — and, worse, still HOLDING
	 * their slot. At `max_av = 1` that slot is the conch, so one crashed tab
	 * silences the room until a human notices and a host intervenes.
	 *
	 * Hosts only, and that is not a UI nicety: `remove_participant` is
	 * self-or-host on the server, so a guest attempting this would simply be
	 * refused. It is also why several hosts racing to reap the same person is
	 * harmless — the second attempt finds nothing to remove and produces an
	 * empty diff.
	 *
	 * `participantLeft` inside the rule engine does the rest: releases both
	 * slots and drops them from the queue, so the conch goes to whoever is
	 * waiting rather than nowhere.
	 */
	$effect(() => {
		if (!isHost) return;
		const current = store;
		return current.onPresenceLeave((actorId) => {
			// Only someone the room still thinks is here. Presence and the
			// participant rows can disagree briefly on join, and reaping a row
			// that was never written would be a pointless write.
			if (untrack(() => current.state.participants[actorId]) === undefined) return;
			void sync.commit({ kind: 'remove_participant', id: actorId });
		});
	});

	/*
	 * The media session (AR-TRANSPORT-1, AR-CTRL-3, AR-TRANSPORT-9).
	 *
	 * This is where the A/V plane is finally plugged in, and it is deliberately
	 * one effect that only ever hands the session a plan input. All the deciding
	 * lives in `planMedia`, which is pure and node-tested; all the negotiating
	 * lives behind the transport seam, which names no provider. What is left here
	 * is wiring.
	 *
	 * `planMedia` returns IDLE for a lone occupant, so `getUserMedia` is never
	 * called for somebody sitting in an empty room — a lurker must not see a
	 * permission dialog they have no use for.
	 */
	let session: MediaSession | null = $state(null);

	/**
	 * Remote streams, keyed `<peer>:<kind>`.
	 *
	 * Audio is in here too and is deliberately NOT rendered by a tile: an audio
	 * element per avatar would be a mixing decision made in the wrong place. It
	 * plays through one element below, which is also where proximity mixing would
	 * later live.
	 */
	const remoteStreams = new SvelteMap<string, MediaStream>();
	/** Holds a share's picture and sound together at a STABLE identity. */
	const combiner = new StreamCombiner();
	/** Just the video, keyed by peer, which is what a tile wants. */
	const videoStreams = $derived.by(() => {
		const byPeer = new SvelteMap<string, MediaStream>();
		for (const [key, stream] of remoteStreams) {
			const [peer, kind] = key.split(':');
			if (kind !== 'video' || peer === undefined) continue;
			byPeer.set(peer, stream);
		}
		// Your own camera goes on your own tile. Everyone else's arrives over a
		// connection; yours never leaves the machine.
		const own = session?.localVideo;
		if (own != null && identity.id !== '') byPeer.set(identity.id, own);
		return byPeer;
	});
	/**
	 * Screen shares, keyed by the OWNER (UX-OBJ-6).
	 *
	 * A separate map from `videoStreams` rather than a merge: one person can be
	 * on camera AND sharing, and the two are keyed identically, so merging them
	 * would put somebody's screen on their own face. `videoStreams` above filters
	 * on `kind !== 'video'`, which already excludes these.
	 */
	const screenStreams = $derived.by(() => {
		const byPeer = new SvelteMap<string, MediaStream>();
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, rebuilt by the derived
		const sound = new Map<string, MediaStream>();
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, rebuilt by the derived
		const picture = new Map<string, MediaStream>();
		for (const [key, stream] of remoteStreams) {
			const [peer, kind] = key.split(':');
			if (peer === undefined) continue;
			if (kind === 'screen') picture.set(peer, stream);
			if (kind === 'screenaudio') sound.set(peer, stream);
		}
		/*
		 * Joined through the combiner, never with a `new MediaStream(...)` here
		 * (UX-OBJ-16). This derivation re-runs whenever ANY peer's ANY track
		 * moves, so minting inline would hand the element a fresh `srcObject`
		 * every time somebody unrelated switched their camera on — restarting
		 * playback and resetting the viewer's mute, with nothing failing.
		 */
		for (const [peer, video] of picture) {
			byPeer.set(peer, combiner.combine(peer, video, sound.get(peer)));
		}
		// Your own screen never leaves the machine; you see it locally, and it is
		// deliberately picture-only — see `localScreen` in session.svelte.ts.
		const own = session?.localScreen;
		if (own != null && identity.id !== '') byPeer.set(identity.id, own);
		return byPeer;
	});

	/**
	 * Every remote VOICE, played through one element each.
	 *
	 * Split on the key rather than tested with `endsWith(':audio')`, which was
	 * correct only by the accident that `':screenaudio'` does not end with
	 * `':audio'`. A share's sound belongs to its object, not to this loop.
	 */
	const audioStreams = $derived.by(() => {
		const streams: { key: string; stream: MediaStream }[] = [];
		for (const [key, stream] of remoteStreams) {
			const [, kind] = key.split(':');
			if (kind !== 'audio') continue;
			streams.push({ key, stream });
		}
		return streams;
	});

	/*
	 * The id alone, so the session is not rebuilt for an unrelated change.
	 *
	 * `identity` is replaced wholesale when the roamed profile lands, so an
	 * effect reading it re-ran and tore down a working transport to build an
	 * identical one. A derived primitive settles: Svelte compares it by value, so
	 * a new object carrying the same id changes nothing.
	 */
	const selfId = $derived(identity.id);

	/** `srcObject` is a property, not an attribute, so it cannot be set in markup. */
	function attachStream(node: HTMLMediaElement, stream: MediaStream) {
		node.srcObject = stream;
		void node.play().catch(() => undefined);
		return {
			destroy() {
				node.srcObject = null;
			}
		};
	}

	$effect(() => {
		const current = store;
		// EMPTY_IDENTITY is the sentinel for "not known yet" — its id is '' and
		// deliberately unusable, so this is the same check as "do we have one".
		const me = selfId;
		if (me === '') return;

		// The key is a promise: an offer can arrive before the fetch lands, and
		// waiting for it beats refusing for want of it.
		const authorizer = new PublishAuthorizer(roomId, mediaPublicKey());
		const transport = new P2PTransport({
			self: current.endpoint,
			ice: [],
			authorizer,
			endpoints: () => current.endpoints,
			send: (to, payload) => {
				current.sendSignal(to, payload);
			}
		});

		const active = new MediaSession({
			store: current,
			roomName: room,
			self: me,
			transport,
			onRemoteTrack: (track) => {
				remoteStreams.set(`${track.peer}:${track.kind}`, track.stream);
			},
			onTrackEnded: (peer, kind) => {
				remoteStreams.delete(`${peer}:${kind}`);
			},
			onGrant: (grant) => {
				transport.setGrant(grant);
			},
			onCredentials: (raw) => {
				transport.useCredentials(raw);
			},
			onStage: (holders) => {
				transport.setStage(holders);
			},
			/*
			 * The browser's own "Stop sharing" bar (UX-OBJ-6).
			 *
			 * Nothing else can observe this — the track simply dies, no state
			 * changes, and a reconcile pass has no reason to run. Committing the
			 * mutation here is what releases the slot and removes the object for
			 * everyone else.
			 */
			onScreenEnded: () => {
				void sync.commit({ kind: 'stop_screenshare', id: me }).catch(() => undefined);
			}
		});

		const stopSignals = current.onSignal((from, payload) => {
			transport.accept(from, payload);
		});

		session = active;
		return () => {
			stopSignals();
			active.dispose();
			session = null;
			remoteStreams.clear();
			// The memo outlives nothing: a rejoin must not replay a dead share.
			combiner.clear();
		};
	});

	/*
	 * Re-plan whenever the inputs change.
	 *
	 * Reading `present`, the holder lists and each tile's width makes this
	 * effect depend on exactly what `planMedia` consumes, so a slot changing
	 * hands, somebody arriving, or a tile being resized all re-run it — and
	 * nothing else does.
	 */
	$effect(() => {
		const active = session;
		if (active === null) return;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, not state
		const tiles = new Map<string, { deviceWidth: number }>();
		for (const [id, participant] of Object.entries(store.state.participants)) {
			tiles.set(id, { deviceWidth: Math.round(participant.size.width) });
		}
		/*
		 * Share sizes come from the SHARE OBJECT, not the sharer's avatar
		 * (UX-OBJ-6). They are separate objects at separate scales, and reading
		 * the avatar here would send a full-screen share at thumbnail quality.
		 */
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, not state
		const screenTiles = new Map<string, { deviceWidth: number }>();
		for (const object of Object.values(store.state.objects)) {
			if (object.type !== 'screenshare') continue;
			screenTiles.set(object.payload.owner_id, {
				deviceWidth: Math.round(object.transform.width)
			});
		}
		// Tracked explicitly so the effect re-runs on the things the plan reads.
		void store.present.length;
		void store.state.video_holders.length;
		void store.state.audio_holders.length;
		void store.state.screen_holders.length;
		void untrack(() => active.reconcile(tiles, screenTiles));
	});

	/**
	 * Start sharing (UX-OBJ-6). The ORDER of these four steps is the whole trick.
	 *
	 * The picker comes FIRST, as the very first statement, because
	 * `getDisplayMedia` needs user activation and any await before it spends the
	 * gesture. That rules out the otherwise-obvious "take the slot, then prompt":
	 * it loses activation across the commit AND strands a slot when somebody
	 * opens the picker and changes their mind.
	 *
	 * The cost of this order is a wasted picker when the room is full — we ask
	 * what to share and only then discover there is no room for it. The button is
	 * disabled when the pool is full, which closes all of that but the race.
	 */
	async function onShareScreen(): Promise<void> {
		const active = session;
		if (active === null) return;

		const track = await active.startScreenShare();
		// They cancelled. Not an error, and nothing to undo.
		if (track === null) return;

		const objects = untrack(() => Object.values(store.state.objects));
		try {
			await sync.commit({
				kind: 'start_screenshare',
				id: identity.id,
				object: newScreenshare(
					identity.id,
					centerWorld(),
					maxZOf(objects),
					store.state.border_default
				)
			});
			sync.announce('Sharing your screen');
		} catch {
			// Refused — someone took the last slot between the click and the
			// commit. Give the capture back rather than leaving the browser's
			// "Stop sharing" bar up for a share that does not exist.
			active.stopScreenShare();
		}
	}

	function onStopScreenShare(): void {
		// The mutation releases the slot and deletes the object; the local track
		// is dropped immediately so the hardware indicator goes out at once
		// rather than after a round trip.
		session?.stopScreenShare();
		void sync.commit({ kind: 'stop_screenshare', id: identity.id }).catch(() => undefined);
	}

	/*
	 * My share object is gone, so give the hardware back (UX-OBJ-6).
	 *
	 * The rule engine guarantees the STATE invariant — a screenshare object never
	 * outlives its slot. This guarantees the other half of it, which no amount of
	 * shared state can: that the browser stops capturing. Someone with edit
	 * permission deleting my share, or a host revoking it, both land here, and
	 * without it the "Stop sharing" bar would linger over a share nobody can see.
	 */
	$effect(() => {
		const active = session;
		if (active === null) return;
		if (active.localScreen === null) return;
		const mine = Object.values(store.state.objects).some(
			(object) => object.type === 'screenshare' && object.payload.owner_id === identity.id
		);
		if (mine) return;
		untrack(() => {
			active.stopScreenShare();
		});
	});

	/*
	 * Mirror the live connection count onto the document, beside `data-syncing`.
	 *
	 * The same reasoning as that attribute: a test needs one honest signal for
	 * "the media plane is up", and inventing a per-test proxy is how fixed sleeps
	 * get written. It says something the rendered tiles cannot — a connection is
	 * established BEFORE anyone publishes (AR-TRANSPORT-9), so a peer count is
	 * observable in a room where there is deliberately nothing to see.
	 */
	$effect(() => {
		document.documentElement.dataset['mediaPeers'] = String(session?.connected ?? 0);
	});

	const count = $derived(Object.keys(store.state.participants).length);
	/** Placers are a host tool (UX-AV-2), and the gate is live now. */
	const canDesign = $derived(canDesignRoom(isHost));

	/**
	 * Say so when the room moved you (AR-CTRL-4).
	 *
	 * Entry re-validates a remembered location rather than trusting it, so
	 * someone who returns to a spot that content has since taken lands
	 * somewhere else. That was correct but SILENT — you came back, you were
	 * somewhere new, and nothing accounted for it. Sighted users at least see
	 * the difference; without vision there was no signal at all.
	 *
	 * Derived, not plumbed: both the remembered spot and the actual one are
	 * already in room state, so the displacement is a comparison rather than a
	 * new channel through the store seam.
	 */
	const displaced = $derived(wasDisplaced(store.state, identity.id));
	let announcedDisplacement = false;
	$effect(() => {
		if (!displaced) {
			announcedDisplacement = false;
			return;
		}
		if (announcedDisplacement) return;
		announcedDisplacement = true;
		sync.announce('Your usual spot was taken, so you were placed nearby');
	});

	/**
	 * UX-STAGE-9: the room surfaces live counts and the queue with its order,
	 * so "scarcity is legible before you bump into it". Computed by the pure
	 * module — this component renders it, it does not derive it (AR-TEST-4).
	 */
	const stage = $derived<StageState>({
		capacity: store.state.capacity,
		video_holders: store.state.video_holders,
		audio_holders: store.state.audio_holders,
		screen_holders: store.state.screen_holders,
		queue: store.state.queue
	});
	const slots = $derived(stageCounts(stage));
	const nameOf = (id: string): string => store.state.participants[id]?.name ?? 'Someone';

	function setCapacity(next: Partial<Capacity>): void {
		void sync.commit({ kind: 'set_capacity', capacity: { ...stage.capacity, ...next } });
	}
	/** Stub-only: chat history evicted to bound localStorage (CHAT_LOG_LIMIT). */
	const dropped = $derived(store instanceof MemoryRoomStore ? store.droppedChatMessages : 0);

	/** Pointer-free creation (UX-A11Y-2) at the viewport center. */
	function centerWorld(): { x: number; y: number } {
		return viewport.toWorld({ x: viewport.size.width / 2, y: viewport.size.height / 2 });
	}
	function addNote(): void {
		const objects = untrack(() => Object.values(store.state.objects));
		void sync.commit({ kind: 'create_object', object: newNote(identity.id, centerWorld(), maxZOf(objects), store.state.border_default) });
		sync.announce('Note added');
	}
	function addTimer(): void {
		const objects = untrack(() => Object.values(store.state.objects));
		void sync.commit({ kind: 'create_object', object: newTimer(identity.id, centerWorld(), maxZOf(objects), store.state.border_default) });
		sync.announce('Timer added');
	}
	/**
	 * Lay out a spot for the next newcomer (UX-AV-2). Created at the viewport
	 * centre like any other addition, sized to the default avatar so the host
	 * sees the footprint an arrival will actually take.
	 */
	function addPlacer(): void {
		const at = centerWorld();
		void sync.commit({
			kind: 'add_placer',
			placer: {
				id: crypto.randomUUID(),
				x: at.x,
				y: at.y,
				width: AVATAR_SIZE,
				height: AVATAR_SIZE,
				rotation: 0,
				clip: { shape: 'circle' }
			}
		});
		sync.announce(`Newcomer spot ${String(store.state.placers.length + 1)} added`);
	}
	function addChat(): void {
		const objects = untrack(() => Object.values(store.state.objects));
		void sync.commit({ kind: 'create_object', object: newChat(identity.id, centerWorld(), maxZOf(objects), store.state.border_default) });
		sync.announce('Chat added');
	}

	/**
	 * Signed URLs for image objects, keyed by Storage path (UX-OBJ-5).
	 *
	 * Minted here rather than in the renderer because Room owns the Supabase
	 * client; WorldCanvas stays a pure renderer that only receives the map. The
	 * bucket is private (image access rides the same room-membership RLS as every
	 * object), so the render layer cannot use a stable public URL — each path is
	 * signed on demand and dropped when its object leaves.
	 */
	const imageUrls = new SvelteMap<string, string>();
	// When each URL was minted, so an expiry (old) can be told from a dead blob
	// (fresh but already failing). Plain Map: only read/written in these helpers,
	// never in markup or a derived, so it needs no reactivity.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- non-reactive bookkeeping, never rendered
	const imageMintedAt = new Map<string, number>();

	/** Sign one path and record when, overwriting any prior URL for it. */
	function mintSignedUrl(path: string): void {
		imageMintedAt.set(path, Date.now());
		void supabaseBrowser()
			.storage.from(IMAGE_BUCKET)
			.createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
			.then(({ data }) => {
				if (data?.signedUrl !== undefined) imageUrls.set(path, data.signedUrl);
			})
			.catch(() => undefined);
	}

	$effect(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, rebuilt each run and never a reactive source
		const paths = new Set<string>();
		for (const object of Object.values(store.state.objects)) {
			if (object.type === 'image') paths.add(object.payload.path);
		}
		// Only `paths` (derived from room state) should drive this effect; reading
		// and writing `imageUrls` inside it must not, or minting one URL would
		// re-run the whole thing.
		untrack(() => {
			for (const path of paths) {
				if (!imageUrls.has(path)) mintSignedUrl(path);
			}
			for (const path of [...imageUrls.keys()]) {
				if (!paths.has(path)) {
					imageUrls.delete(path);
					imageMintedAt.delete(path);
				}
			}
		});
	});

	/**
	 * An image tile whose URL just failed to load (UX-OBJ-5). A signed URL lives
	 * an hour; a tile open longer than that would otherwise break for good. Re-mint
	 * ONLY if the URL is old enough to have plausibly expired — a fresh URL that
	 * already fails is a dead blob, and re-minting it loops forever
	 * (`shouldRefreshSignedUrl`). A new URL flows down as a fresh `src`, which
	 * ImageObject retries automatically.
	 */
	function onImageExpired(path: string): void {
		if (shouldRefreshSignedUrl(imageMintedAt.get(path), Date.now())) mintSignedUrl(path);
	}

	/**
	 * Adding an image is the one creation that needs a file first (UX-OBJ-5), so
	 * it goes through a hidden `<input type="file">` the button clicks. The bytes
	 * upload straight to Storage (image-upload.ts); only the resulting object
	 * goes through the control plane, like every other create.
	 */
	let imageInput = $state<HTMLInputElement | null>(null);
	function pickImage(): void {
		imageInput?.click();
	}
	function onImagePicked(): void {
		// Read from the bound input rather than event.currentTarget, which avoids a
		// cast and is the same element anyway.
		const input = imageInput;
		if (input === null) return;
		const file = input.files?.[0];
		// Clear so picking the SAME file again still fires a change event.
		input.value = '';
		if (file === undefined) return;
		void addImageFromFile(file, centerWorld());
	}

	/**
	 * The one path every image creation takes — the toolbar picker, a drop, or a
	 * paste (UX-OBJ-5). `world` is where it lands: the cursor for a drop, the
	 * viewport centre for the picker and a paste.
	 *
	 * Both pre-checks run BEFORE the upload, so a refused create never leaves an
	 * orphaned blob: `mayCreate` because drop/paste bypass the disabled toolbar
	 * button (its message matches the server's `requireMayCreate`), and the count
	 * because a full room would reject the create anyway. The server enforces both
	 * regardless — and cleans up a blob if a race slips a create past these into a
	 * rejection (see the mutate route).
	 */
	async function addImageFromFile(file: File, world: { x: number; y: number }): Promise<void> {
		if (!mayCreate) {
			sync.announce('Only hosts may add objects in this room');
			return;
		}
		const images = untrack(
			() => Object.values(store.state.objects).filter((o) => o.type === 'image').length
		);
		if (images >= MAX_IMAGES_PER_ROOM) {
			sync.announce(
				`This room already holds the most images it can (${String(MAX_IMAGES_PER_ROOM)})`
			);
			return;
		}
		try {
			const ref = await uploadImage(supabaseBrowser(), file, roomId);
			const objects = untrack(() => Object.values(store.state.objects));
			void sync.commit({
				kind: 'create_object',
				object: newImage(identity.id, world, maxZOf(objects), ref, store.state.border_default)
			});
			sync.announce('Image added');
		} catch (error) {
			sync.announce(
				error instanceof ImageUploadError ? error.message : 'That image could not be added'
			);
		}
	}

	/**
	 * Drop image files onto the canvas (UX-OBJ-5), placed where they land. A
	 * pointer nicety alongside the keyboard-reachable toolbar button; non-image
	 * files are ignored, and each image runs the same guarded upload path.
	 */
	let dropActive = $state(false);
	function onDragOver(event: DragEvent): void {
		// Only care about a real file drag; an object drag on the canvas uses
		// pointer events, not this.
		if (event.dataTransfer === null || !event.dataTransfer.types.includes('Files')) return;
		event.preventDefault(); // required, or the browser refuses the drop
		dropActive = true;
	}
	function onDrop(event: DragEvent): void {
		const files = imageFilesFrom(event.dataTransfer?.files ?? null);
		dropActive = false;
		if (files.length === 0) return;
		event.preventDefault();
		const world = viewport.toWorld({ x: event.clientX, y: event.clientY });
		for (const file of files) void addImageFromFile(file, world);
	}

	/**
	 * Paste an image from the clipboard (UX-OBJ-5). A window listener because a
	 * paste is not aimed at a canvas element; guarded so a paste INTO a text field
	 * (a note, chat, or the alt caption — all marked `data-editable`) stays a text
	 * paste and never also drops an image on the canvas.
	 */
	$effect(() => {
		function onPaste(event: ClipboardEvent): void {
			const active = document.activeElement;
			if (active instanceof HTMLElement && active.closest('[data-editable]') !== null) return;
			const files = imageFilesFrom(event.clipboardData?.files ?? null);
			if (files.length === 0) return;
			event.preventDefault();
			for (const file of files) void addImageFromFile(file, centerWorld());
		}
		window.addEventListener('paste', onPaste);
		return () => {
			window.removeEventListener('paste', onPaste);
		};
	});
	/**
	 * Change your own name/face (UX-ID-1, UX-AV-3). Writes BOTH the per-browser
	 * identity and the room's participant record: the first is what you carry
	 * to other rooms, the second is what this room shows. `saveIdentity` was
	 * exported and never called until now, so a chosen name could not survive
	 * a reload.
	 */
	function saveMe(): void {
		if (!identityReady) return;
		const next = { ...identity, name: nameDraft.trim(), emoji: emojiDraft };
		saveIdentity(next);
		identity = next;
		void sync.commit({ kind: 'set_identity', id: identity.id, name: next.name, emoji: next.emoji });

		// THREE places, because they answer three different questions:
		//   localStorage — who am I in this browser, offline, before any network
		//   the room     — who is that on the canvas, for everyone here now
		//   the profile  — who am I everywhere, on my next machine (UX-ID-6)
		// Writing only the first two is what made a second machine show a
		// stranger's blank face.
		void saveMyProfile(supabaseBrowser(), { name: next.name, emoji: next.emoji });
		sync.announce('Your name and face were updated');
	}

	/** UX-OBJ-9: creation permission is a ROOM setting, default all-may-create. */
	const mayCreate = $derived(store.state.create_permission === 'all');
	/** UX-ID-3's door. Host-only, enforced server-side like every room setting. */
	function setAdmission(value: 'open' | 'ask'): void {
		void sync.commit({ kind: 'set_room_admission', value });
	}

	function setCreatePermission(value: 'all' | 'host'): void {
		void sync.commit({ kind: 'set_room_create_permission', value });
		sync.announce(value === 'all' ? 'Anyone can add objects' : 'Only hosts can add objects');
	}

	function setBackground(value: string): void {
		void sync.commit({ kind: 'set_background', value });
		sync.announce('Background changed');
	}
	function saveMeta(title: string, description: string): void {
		void sync.commit({ kind: 'set_room_meta', title, description });
	}
	function saveConfig(): void {
		const name = configNameDraft.trim();
		if (name === '') return;
		void sync.commit({ kind: 'save_config', id: crypto.randomUUID(), name });
		sync.announce(`Saved layout ${name}`);
		configNameDraft = '';
	}
	/** UX-ROOM-4/6: update the configuration you are currently in. */
	function updateConfig(): void {
		void sync.commit({ kind: 'update_config' });
		sync.announce('Layout updated');
	}
	function renameConfig(id: string, name: string): void {
		const trimmed = name.trim();
		if (trimmed === '') return;
		void sync.commit({ kind: 'rename_config', id, name: trimmed });
	}

	function switchConfig(id: string): void {
		void sync.commit({ kind: 'switch_config', id });
		sync.announce('Switched layout');
	}
	function resetConfig(): void {
		void sync.commit({ kind: 'reset_config' });
		sync.announce('Layout reset');
	}
	function deleteConfig(id: string): void {
		void sync.commit({ kind: 'delete_config', id });
	}
	/** Why the rename cannot proceed, or null. Shown next to the field. */
	const renameProblem = $derived.by(() => {
		if (renameDraft.trim() === '') return null;
		const problem = roomNameProblem(renameDraft);
		if (problem !== null) return roomNameMessage(problem);
		if (canonicalRoomName(renameDraft) === room) return 'That is already this room\u2019s name.';
		return null;
	});
	const renameReady = $derived(renameDraft.trim() !== '' && renameProblem === null);

	/**
	 * UX-ROOM-10 requires hosts be WARNED before renaming, because existing
	 * links break. That warning was simply missing — and unlike the two
	 * behaviors the stub cannot yet honor (freeing the old name, and old URLs
	 * ceasing to resolve), nothing admitted its absence.
	 */
	/** SvelteKit's error body, for reporting a refused rename. */
	const z_message = z.object({ message: z.string() });

	function renameRoom(): void {
		if (!renameReady) return;
		const name = canonicalRoomName(renameDraft);
		const ok = confirm(
			`Rename this room to “${name}”?\n\n` +
				'Anyone holding a link to the current name will lose access to this room. ' +
				'Links cannot be updated for them.'
		);
		if (!ok) return;
		// The room is renamed SERVER-side and then navigated to. The stub used to
		// copy one localStorage key to another, which worked only because it
		// conjured a room for any name and freed nothing — so the warning above
		// was not yet true. It is now: the old name is released by the same
		// update, and old links stop resolving.
		void (async () => {
			const response = await fetch(`/api/rooms/${room}/rename`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!response.ok) {
				const problem: unknown = await response.json().catch(() => null);
				const message = z_message.safeParse(problem);
				sync.announce(
					`Rename failed: ${message.success ? message.data.message : 'the room was not renamed'}`
				);
				return;
			}
			await goto(resolve('/hey/[room]', { room: name }));
		})();
	}
</script>

<!--
	The toolbar measures itself into --chrome-top-drop so its popovers open
	BELOW it even after it wraps onto a second row. Wrapping is why the old
	fixed-offset menus overlapped the bar on narrow windows.
-->
<header class="bar panel" bind:clientHeight={barHeight} style:--chrome-top-drop="{barHeight + 20}px">
	<Popover id="room-menu" label="Room settings" anchor="top-start">
		{#snippet trigger()}
			<strong>{store.state.title === '' ? room : store.state.title}</strong>
		{/snippet}
		<div class="menu">
			<Field
				label="Room title"
				value={store.state.title}
				placeholder={room}
				oncommit={(title: string) => {
					saveMeta(title, store.state.description);
				}}
			/>
			<Field
				label="Room description"
				multiline
				value={store.state.description}
				oncommit={(description: string) => {
					saveMeta(store.state.title, description);
				}}
			/>
			<div class="row" role="group" aria-label="Who can add objects">
				<Button
					pressed={mayCreate}
					onclick={() => {
						setCreatePermission('all');
					}}>anyone adds</Button
				>
				<Button
					pressed={!mayCreate}
					onclick={() => {
						setCreatePermission('host');
					}}>hosts only</Button
				>
			</div>
			{#if !mayCreate && !isHost}
				<!-- The warning that used to say "hosts only means nobody" is gone:
				     the role exists (AR-CTRL-7), so the setting does what it says.
				     What remains is telling a GUEST why the add buttons are dead,
				     which is otherwise indistinguishable from a broken toolbar. -->
				<p class="problem" role="alert">Only a host can add objects in this room.</p>
			{/if}
			{#if isHost}
				<div class="row" role="group" aria-label="Who may enter">
					<Button
						pressed={store.state.admission === 'open'}
						onclick={() => {
							setAdmission('open');
						}}>anyone enters</Button
					>
					<Button
						pressed={store.state.admission === 'ask'}
						onclick={() => {
							setAdmission('ask');
						}}>ask first</Button
					>
				</div>
				<!-- Who is waiting, and the decision. Hosts only: a guest cannot
				     read the pending set, and would have nothing to do with it. -->
				<PendingGuests {roomId} roomName={room} />
			{/if}
			<!-- Host-only, because the server now enforces it (UX-ROOM-10). Offered
			     to everyone, it was a control that could only ever fail — and
			     while the rename was stub-local it appeared to work for guests
			     too, which is worse than refusing them. -->
			{#if isHost}
				<div class="row">
					<Field label="New room name" bind:value={renameDraft} placeholder="new-name" />
					<Button disabled={!renameReady} onclick={renameRoom}>rename</Button>
				</div>
				{#if renameProblem !== null}
					<p class="problem" role="alert">{renameProblem}</p>
				{/if}
			{/if}
		</div>
	</Popover>

	<Popover id="me-menu" label="You" anchor="top-start">
		{#snippet trigger()}
			<Emoji glyph={identity.emoji} /> {identity.name}
		{/snippet}
		<div class="menu">
			<Field label="Your name" bind:value={nameDraft} placeholder="e.g. Amy" />
			<fieldset class="faces">
				<legend>Your face</legend>
				<EmojiPicker label="Your face" bind:value={emojiDraft} choices={AVATAR_EMOJI} />
			</fieldset>
			<Button variant="primary" disabled={!identityReady} onclick={saveMe}>save</Button>
		</div>
	</Popover>

	<span class="count">{count} here</span>
	<span class="count" aria-label="Stage capacity">
		{slots.video.held}/{slots.video.max} video · {slots.audio.held}/{slots.audio.max} audio
	</span>

	<Popover id="stage-menu" label="stage" anchor="top-start">
		<div class="menu">
			<p class="hint">
				Three numbers are the whole stage policy (UX-STAGE-2): one video slot is a
				turn-taking conch, many is a gallery.
			</p>
			<div class="row">
				<Field
					label="Video slots"
					value={String(stage.capacity.max_av)}
					oncommit={(v: string) => {
						setCapacity({ max_av: Number(v) || 0 });
					}}
				/>
				<Field
					label="Audio slots"
					value={String(stage.capacity.max_audio)}
					oncommit={(v: string) => {
						setCapacity({ max_audio: Number(v) || 0 });
					}}
				/>
				<Field
					label="Max people"
					value={String(stage.capacity.max_participants)}
					oncommit={(v: string) => {
						setCapacity({ max_participants: Number(v) || 1 });
					}}
				/>
			</div>
			{#if stage.queue.length > 0}
				<p class="hint">Waiting for a slot, in order:</p>
				<ol class="queue">
					{#each stage.queue as waiting, index (waiting)}
						<li>
							{index + 1}. {nameOf(waiting)}
							<!--
								The queue is the one place a host can act on somebody they
								cannot see: waiting people may be anywhere on an infinite
								canvas, or scrolled off it entirely, which makes their
								avatar unreachable. Everywhere else, the controls live on
								the avatar itself (UX-STAGE-4).
							-->
							{#if isHost && waiting !== identity.id}
								<HostSlotControls {store} {sync} id={waiting} name={nameOf(waiting)} />
							{/if}
						</li>
					{/each}
				</ol>
			{:else}
				<p class="hint">Nobody is waiting.</p>
			{/if}
		</div>
	</Popover>
	<Button disabled={!mayCreate} onclick={addNote}>+ <Emoji glyph={ADD_EMOJI.note} /> note</Button>
	<Button disabled={!mayCreate} onclick={addTimer}>+ <Emoji glyph={ADD_EMOJI.timer} /> timer</Button>
	<Button disabled={!mayCreate} onclick={addChat}>+ <Emoji glyph={ADD_EMOJI.chat} /> chat</Button>
	<Button disabled={!mayCreate} onclick={pickImage}>+ <Emoji glyph={ADD_EMOJI.image} /> image</Button>
	<!-- The picker the image button opens. Hidden, pointer-free-reachable via the
	     button (UX-A11Y-2), and accepting only the formats the bucket allows. -->
	<!--
		`aria-label` is not decoration here: sr-only hides it visually but leaves
		it in the accessibility tree, where it was an unlabelled file input — a
		real WCAG 2.2 "form elements must have labels" violation that failed the
		axe gate (UX-A11Y-1, AR-STYLE-3) in both themes. A visually-hidden
		control still has to name itself.
	-->
	<input
		bind:this={imageInput}
		type="file"
		aria-label="Choose an image to add to the room"
		accept="image/png,image/jpeg,image/webp,image/gif"
		class="sr-only"
		onchange={onImagePicked}
	/>
	<!-- A host tool, not content: placers say where NEWCOMERS land (UX-AV-2). -->
	{#if canDesign}
		<Button onclick={addPlacer}>+ <Emoji glyph={ADD_EMOJI.placer} /> newcomer spot</Button>
	{/if}

	<Popover id="config-menu" label="layouts" anchor="top-start">
		<div class="menu">
			{#each Object.values(store.state.configurations) as config (config.id)}
				<div class="row">
					<Button
						pressed={store.state.active_config === config.id}
						onclick={() => {
							switchConfig(config.id);
						}}>{config.name}</Button
					>
					<Button
						shape="icon"
						label="Rename layout {config.name}"
						onclick={() => {
							const next = prompt('Rename layout', config.name);
							if (next !== null) renameConfig(config.id, next);
						}}>✎</Button
					>
					<Button
						shape="icon"
						label="Delete layout {config.name}"
						onclick={() => {
							deleteConfig(config.id);
						}}>×</Button
					>
				</div>
			{/each}
			<!--
				Reset restores the ACTIVE configuration's layout (UX-ROOM-5), so with
				no configuration saved there is nothing to restore. It used to be
				offered anyway and silently do nothing; now it says why.
			-->
			<!--
				Update the ACTIVE configuration in place. Before this, "save" always
				minted a new id, so configurations accumulated and could never be
				corrected — you could only ever add another near-duplicate.
			-->
			<Button
				variant="primary"
				disabled={store.state.active_config === null}
				title={store.state.active_config === null
					? 'Switch to a layout to update it'
					: undefined}
				onclick={updateConfig}>⤓ update this layout</Button
			>
			<Button
				disabled={store.state.active_config === null}
				title={store.state.active_config === null
					? 'Save a layout first — reset restores it'
					: undefined}
				onclick={resetConfig}>↺ reset layout</Button
			>
			<div class="row">
				<Field label="Layout name" bind:value={configNameDraft} placeholder="e.g. Standup" />
				<Button onclick={saveConfig}>save</Button>
			</div>
		</div>
	</Popover>

	<Popover id="bg-menu" label="background" anchor="top-start">
		<!-- Brightness levels are mutually exclusive, so: a radiogroup. -->
		<div class="menu" role="radiogroup" aria-label="Room brightness">
			{#each BACKGROUND_LEVELS as level (level.name)}
				<Button
					pressed={store.state.background === level.value}
					onclick={() => {
						setBackground(level.value);
					}}>{level.name}</Button
				>
			{/each}
			<hr />
			<div class="menu" role="radiogroup" aria-label="Room gradient">
				{#each BACKGROUND_GRADIENTS as gradient (gradient.name)}
					<Button
						pressed={store.state.background === gradient.value}
						onclick={() => {
							setBackground(gradient.value);
						}}>{gradient.name}</Button
					>
				{/each}
			</div>
		</div>
	</Popover>

	<Button
		pressed={drawMode}
		onclick={() => {
			drawMode = !drawMode;
		}}>✎ draw</Button
	>
	{#if drawMode}
		<SwatchPicker label="Draw color" bind:value={drawColor} swatches={DRAW_COLORS} />
	{/if}
	{#if dropped > 0}
		<!-- The stub evicts old chat messages to bound localStorage (UX-OBJ-3
		     deviation). Saying so beats losing history silently. -->
		<span class="warn" role="status"
			>{dropped} old chat {dropped === 1 ? 'message' : 'messages'} dropped (stub storage limit)</span
		>
	{/if}
	<span class="hint">double-click the canvas to add a note</span>
</header>

<!-- Drop an image file anywhere on the room to add it (UX-OBJ-5). dragleave
     clears the hint only when the pointer leaves `main` itself, not on every
     child boundary crossing (relatedTarget is outside). -->
<main
	class:dropping={dropActive}
	ondragover={onDragOver}
	ondrop={onDrop}
	ondragleave={(e) => {
		if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) {
			dropActive = false;
		}
	}}
>
	<WorldCanvas
		{store}
		{sync}
		{viewport}
		{identity}
		{isHost}
		{drawMode}
		{drawColor}
		{videoStreams}
		{screenStreams}
		{imageUrls}
		{onImageExpired}
		cameraDenied={session?.cameraDenied ?? false}
	/>
	{#if dropActive}
		<!-- Decorative: the drop works whether or not this is seen, and a
		     screen-reader user is not dragging a file with a pointer. -->
		<div class="drop-overlay" aria-hidden="true"><span>Drop to add an image</span></div>
	{/if}
	<!-- Remote audio, off-canvas and unstyled.
	     One element per peer rather than per tile: a tile is a position on a
	     canvas and audio has no position yet, so mixing there would be a decision
	     made in the wrong place. Proximity audio (Later) replaces this element,
	     not the avatars. -->
	{#each audioStreams as entry (entry.key)}
		<audio use:attachStream={entry.stream} autoplay></audio>
	{/each}
	<!-- ONE bottom toolbar: emotes, camera, and theme. Three separate floating
	     clusters used to compete for this corner and overlap each other. -->
	<BottomBar {store} {sync} {identity} {viewport} {onShareScreen} {onStopScreenShare} />
	<!-- Teaches Shift-to-snap at the only moment it matters: mid-gesture. -->
	<HintBar />
	<!-- Stub-only: the panel injects latency and forces rejections, levers that
	     do not exist against the real backend. Dead controls would be worse
	     than an absent panel. -->
	{#if import.meta.env.DEV && store instanceof MemoryRoomStore}
		<DevPanel {store} {sync} />
	{/if}
</main>

<!-- Transient outcomes are perceivable without vision (UX-A11Y-3). -->
<div class="sr-only" aria-live="polite">{sync.announcement}</div>

<style>
	.bar {
		position: fixed;
		top: var(--space-3);
		left: var(--space-3);
		z-index: var(--z-chrome);
		display: flex;
		/* Wrap instead of overflowing. It was a hard non-wrapping row, so on a
		   narrow window the right-hand controls ran off-screen with no scroll
		   to reach them (main is fixed; inset: 0). */
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: center;
		/* Never wider than the viewport, and never taller than it either. */
		max-width: calc(100vw - 2 * var(--space-3));
		max-height: calc(100vh - 2 * var(--space-3));
		overflow: auto;
		padding: var(--space-2) var(--space-3);
		font-size: var(--text-sm);
	}
	.count,
	.hint {
		color: var(--text-muted);
	}
	.hint {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.queue {
		margin: 0;
		padding-left: var(--space-4);
		font-size: var(--text-sm);
	}
	.warn,
	.problem {
		color: var(--danger);
	}
	.problem {
		margin: 0;
		font-size: var(--text-sm);
	}
	/* Popover body layout only; Field and Button paint themselves. */
	.menu {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.row {
		display: flex;
		gap: var(--space-1);
		align-items: flex-end;
	}
	.faces {
		margin: 0;
		padding: 0;
		border: none;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.faces legend {
		padding: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}

	/* The file-drop affordance (UX-OBJ-5). `main` is fixed/inset:0, so this
	   absolute layer covers the canvas; pointer-events:none keeps the drop itself
	   landing on the canvas beneath. */
	.drop-overlay {
		position: absolute;
		inset: 0;
		z-index: var(--z-overlay);
		display: grid;
		place-items: center;
		pointer-events: none;
		outline: 3px dashed var(--accent);
		outline-offset: -10px;
	}
	.drop-overlay span {
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius-full);
		background: var(--accent);
		color: var(--accent-contrast);
		font-size: var(--text-lg);
		font-weight: 600;
	}
</style>
