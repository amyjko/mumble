import { beforeAll, describe, expect, it, vi } from 'vitest';
import { signGrant, type Grant, type GrantBody } from '$lib/media/grant';
import type { RemoteTrack } from '$lib/media/transport';
import { PublishAuthorizer } from './authorize';
import { P2PTransport } from './p2p-transport';

/**
 * Two whole transports, wired through a fake store (AR-TRANSPORT-1/10).
 *
 * One layer up from the connection test: this is where actor ids become
 * endpoints, where the gate is fed a real signed grant, and where a revoke has
 * to reach a live subscription. The store is faked — its own behaviour is
 * covered against a real Realtime server elsewhere — and everything below it is
 * genuine.
 */

const ROOM = '11111111-1111-4111-8111-111111111111';
const ALICE = 'aaaaaaaa-1111-4111-8111-111111111111';
const BOB = 'bbbbbbbb-2222-4222-8222-222222222222';
const TAB_A = 'tab-aaaa';
const TAB_B = 'tab-bbbb';

let signing: CryptoKey;
let verifying: CryptoKey;

beforeAll(async () => {
	const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign',
		'verify'
	]);
	signing = pair.privateKey;
	verifying = pair.publicKey;
});

function tone(): MediaStreamTrack {
	const context = new AudioContext();
	const oscillator = context.createOscillator();
	const destination = context.createMediaStreamDestination();
	oscillator.connect(destination);
	oscillator.start();
	const track = destination.stream.getAudioTracks()[0];
	if (track === undefined) throw new Error('no audio track');
	return track;
}

/**
 * A REAL video track with no camera and no picker.
 *
 * `canvas.captureStream()` is the visual counterpart to the oscillator above: a
 * genuine `MediaStreamTrack`, so no type assertion is needed (this codebase
 * bans them) and no permission is involved.
 */
function painted(): MediaStreamTrack {
	const canvas = document.createElement('canvas');
	canvas.width = 320;
	canvas.height = 180;
	const context = canvas.getContext('2d');
	if (context === null) throw new Error('no 2d context');
	context.fillRect(0, 0, canvas.width, canvas.height);
	const track = canvas.captureStream(5).getVideoTracks()[0];
	if (track === undefined) throw new Error('no video track');
	return track;
}

/**
 * Model a peer running code from before the mid→kind map existed, by dropping
 * the field on its way out. Cloned rather than mutated: the payload belongs to
 * the transport that sent it.
 */
function withoutTrackMap(payload: unknown): unknown {
	const clone: unknown = JSON.parse(JSON.stringify(payload));
	if (typeof clone === 'object' && clone !== null && 'tracks' in clone) {
		Reflect.deleteProperty(clone, 'tracks');
	}
	return clone;
}

async function grantFor(peer: string, stage = 10): Promise<Grant> {
	const now = Math.floor(Date.now() / 1000);
	const body: GrantBody = {
		room: ROOM,
		peer,
		publish: { video: true, audio: true, screen: false },
		stage,
		iat: now,
		exp: now + 120
	};
	return signGrant(body, signing);
}

interface Pair {
	alice: P2PTransport;
	bob: P2PTransport;
	bobAuth: PublishAuthorizer;
	tracksAtBob: RemoteTrack[];
	/** Everything Bob sent Alice, so a `want` can be asserted rather than assumed. */
	bobSent: unknown[];
}

interface PairOptions {
	/** Drop the mid→kind map from Alice's descriptions, as an old peer would. */
	readonly aliceOmitsTrackMap?: boolean;
}

/** Both transports, each believing the other holds both slots. */
function pair(options: PairOptions = {}): Pair {
	const endpoints = [
		{ endpoint: TAB_A, actor: ALICE },
		{ endpoint: TAB_B, actor: BOB }
	];
	const tracksAtBob: RemoteTrack[] = [];
	const bobSent: unknown[] = [];

	const aliceAuth = new PublishAuthorizer(ROOM, verifying);
	aliceAuth.setStage({ video: [ALICE, BOB], audio: [ALICE, BOB], screen: [] });
	const bobAuth = new PublishAuthorizer(ROOM, verifying);
	bobAuth.setStage({ video: [ALICE, BOB], audio: [ALICE, BOB], screen: [] });

	const transports: { alice?: P2PTransport; bob?: P2PTransport } = {};

	const alice = new P2PTransport({
		self: TAB_A,
		ice: [],
		authorizer: aliceAuth,
		endpoints: () => endpoints,
		send: (to, payload) => {
			const sent = options.aliceOmitsTrackMap === true ? withoutTrackMap(payload) : payload;
			queueMicrotask(() => {
				if (to === TAB_B) transports.bob?.accept(TAB_A, sent);
			});
		}
	});

	const bob = new P2PTransport({
		self: TAB_B,
		ice: [],
		authorizer: bobAuth,
		endpoints: () => endpoints,
		send: (to, payload) => {
			bobSent.push(payload);
			queueMicrotask(() => {
				if (to === TAB_A) transports.alice?.accept(TAB_B, payload);
			});
		}
	});

	transports.alice = alice;
	transports.bob = bob;
	bob.onRemoteTrack((track) => tracksAtBob.push(track));
	return { alice, bob, bobAuth, tracksAtBob, bobSent };
}

describe('the seam, over a real connection', () => {
	it('carries a published track from one peer to the other', async () => {
		const { alice, bob, tracksAtBob } = pair();
		alice.setGrant(await grantFor(ALICE));

		await alice.addPeer(BOB);
		await bob.addPeer(ALICE);
		await alice.publish('audio', tone());

		await vi.waitFor(
			() => {
				expect(tracksAtBob.length).toBeGreaterThan(0);
			},
			{ timeout: 20_000, interval: 100 }
		);
		// Reported as the PERSON, never the tab: nothing above the seam knows
		// tabs exist.
		expect(tracksAtBob[0]?.peer).toBe(ALICE);
		expect(tracksAtBob[0]?.kind).toBe('audio');

		alice.dispose();
		bob.dispose();
	}, 60_000);

	it('reports stats per connection, and never a relay on loopback', async () => {
		const { alice, bob } = pair();
		alice.setGrant(await grantFor(ALICE));
		await alice.addPeer(BOB);
		await bob.addPeer(ALICE);
		await alice.publish('audio', tone());

		await vi.waitFor(
			async () => {
				const stats = await alice.stats();
				expect(stats[0]?.state).toBe('connected');
			},
			{ timeout: 20_000, interval: 200 }
		);
		const stats = await alice.stats();
		expect(stats).toHaveLength(1);
		expect(stats[0]?.peer).toBe(BOB);
		expect(stats[0]?.relayed).toBe(false);

		alice.dispose();
		bob.dispose();
	}, 60_000);
});

describe('screen shares alongside a camera (UX-OBJ-6)', () => {
	/**
	 * A REAL video track with no camera and no picker.
	 *
	 * `canvas.captureStream()` is the visual counterpart to the oscillator above:
	 * a genuine `MediaStreamTrack`, so no type assertion is needed (this codebase
	 * bans them) and no permission is involved.
	 */
	it('THE regression: unpublishing a share leaves the camera sending', async () => {
		/*
		 * `unpublish` used to narrow with `publication === 'audio' ? 'audio' :
		 * 'video'`, which was correct only while there were exactly two kinds.
		 * The moment shares existed, stopping one stopped the CAMERA instead —
		 * silently, with no error and nothing failing, presenting as "my video
		 * cut out when I stopped sharing".
		 *
		 * Asserted on the transport's own published map rather than on frames
		 * arriving, because the bug was a bookkeeping error and this is where the
		 * books are kept.
		 */
		const { alice, bob } = pair();
		alice.setGrant(await grantFor(ALICE));
		await alice.addPeer(BOB);
		await bob.addPeer(ALICE);

		const camera = painted();
		const screen = painted();
		expect(await alice.publish('video', camera)).toBe('video');
		expect(await alice.publish('screen', screen)).toBe('screen');

		await alice.unpublish('screen');

		// The camera survived; only the share went.
		expect(alice.publishing('video')).toBe(true);
		expect(alice.publishing('screen')).toBe(false);

		alice.dispose();
		bob.dispose();
	}, 60_000);

	it('an unrecognised handle unpublishes nothing at all', async () => {
		// The safe half of the old mistake: a stale id must not take down a live
		// track just because it failed to match.
		const { alice, bob } = pair();
		alice.setGrant(await grantFor(ALICE));
		await alice.addPeer(BOB);
		await bob.addPeer(ALICE);
		await alice.publish('video', painted());

		await alice.unpublish('not-a-kind');
		expect(alice.publishing('video')).toBe(true);

		alice.dispose();
		bob.dispose();
	}, 60_000);

	it('a share arrives at the far side AS a share, not as a camera', async () => {
		/*
		 * A screen track's `track.kind` is 'video', identical to a camera's, so
		 * the receiver cannot tell them apart from the track alone. The mid→kind
		 * map on the description signal is what distinguishes them — and since the
		 * same reading feeds the publish gate, getting it wrong would check a
		 * share against `video_holders` and let a camera holder publish one with
		 * no screen slot.
		 */
		const { alice, bob, bobAuth, tracksAtBob } = pair();
		bobAuth.setStage({ video: [ALICE], audio: [ALICE], screen: [ALICE] });
		alice.setGrant(
			await (async () => {
				const now = Math.floor(Date.now() / 1000);
				return signGrant(
					{
						room: ROOM,
						peer: ALICE,
						publish: { video: true, audio: true, screen: true },
						stage: 10,
						iat: now,
						exp: now + 120
					},
					signing
				);
			})()
		);

		await alice.addPeer(BOB);
		await bob.addPeer(ALICE);
		await alice.publish('video', painted());
		await alice.publish('screen', painted());

		await vi.waitFor(
			() => {
				expect(tracksAtBob.filter((t) => t.kind === 'screen')).toHaveLength(1);
				expect(tracksAtBob.filter((t) => t.kind === 'video')).toHaveLength(1);
			},
			{ timeout: 20_000, interval: 100 }
		);

		alice.dispose();
		bob.dispose();
	}, 60_000);

	it('refuses a share from someone holding only a camera slot', async () => {
		// The authorization hole the mid→kind map closes, asserted directly.
		const { alice, bob, bobAuth, tracksAtBob } = pair();
		bobAuth.setStage({ video: [ALICE], audio: [ALICE], screen: [] });
		alice.setGrant(await grantFor(ALICE));

		await alice.addPeer(BOB);
		await bob.addPeer(ALICE);
		await alice.publish('screen', painted());

		await new Promise((resolve) => setTimeout(resolve, 3_000));
		expect(tracksAtBob).toHaveLength(0);

		alice.dispose();
		bob.dispose();
	}, 60_000);
});

describe('screen audio (UX-OBJ-16)', () => {
	/** A grant covering exactly the kinds a test needs. */
	async function grantWith(publish: {
		video: boolean;
		audio: boolean;
		screen: boolean;
	}): Promise<Grant> {
		const now = Math.floor(Date.now() / 1000);
		const body: GrantBody = { room: ROOM, peer: ALICE, publish, stage: 10, iat: now, exp: now + 120 };
		return signGrant(body, signing);
	}

	it('THE test: a share’s sound arrives as SCREEN audio, not as the microphone', async () => {
		/*
		 * A screen-audio track and a microphone track are both `track.kind ===
		 * 'audio'` and utterly indistinguishable at the receiver — which is why
		 * this test uses the SAME `tone()` helper for both roles. The only thing
		 * telling them apart is the sender's declared map, and this asserts that
		 * the map is now consulted for audio at all.
		 */
		const { alice, bob, bobAuth, tracksAtBob } = pair();
		bobAuth.setStage({ video: [ALICE], audio: [ALICE], screen: [ALICE] });
		alice.setGrant(await grantWith({ video: true, audio: true, screen: true }));

		await alice.addPeer(BOB);
		await bob.addPeer(ALICE);
		await alice.publish('audio', tone());
		await alice.publish('screen', painted());
		await alice.publish('screenaudio', tone());

		await vi.waitFor(
			() => {
				expect(tracksAtBob.filter((t) => t.kind === 'audio')).toHaveLength(1);
				expect(tracksAtBob.filter((t) => t.kind === 'screenaudio')).toHaveLength(1);
				expect(tracksAtBob.filter((t) => t.kind === 'screen')).toHaveLength(1);
			},
			{ timeout: 20_000, interval: 100 }
		);

		alice.dispose();
		bob.dispose();
	}, 60_000);

	it('DEMOTES a share’s sound to the microphone when there is no share', async () => {
		/*
		 * An audio slot does not confer screen audio — but the failure is not a
		 * refusal, and asserting one would be wrong.
		 *
		 * Alice holds an audio slot and no screen slot. Her `screenaudio` claim
		 * is not honoured (no share is declared), so the track is classified as
		 * `'audio'` — her microphone, which she is entitled to send. It flows,
		 * and it flows as VOICE. That is the right outcome: no escalation, and
		 * no silent drop of a track somebody may legitimately be speaking into.
		 *
		 * The property under test is therefore the CLASSIFICATION, not the count.
		 */
		const { alice, bob, bobAuth, tracksAtBob } = pair();
		bobAuth.setStage({ video: [], audio: [ALICE], screen: [] });
		alice.setGrant(await grantWith({ video: false, audio: true, screen: false }));

		await alice.addPeer(BOB);
		await bob.addPeer(ALICE);
		await alice.publish('screenaudio', tone());

		await vi.waitFor(
			() => {
				expect(tracksAtBob).toHaveLength(1);
			},
			{ timeout: 20_000, interval: 100 }
		);
		expect(tracksAtBob[0]?.kind).toBe('audio');
		expect(tracksAtBob.some((t) => t.kind === 'screenaudio')).toBe(false);

		alice.dispose();
		bob.dispose();
	}, 60_000);

	it('an UNMAPPED audio mid is a microphone, so an old peer still works', async () => {
		/*
		 * The fail-closed default, and the reason it is `'audio'` rather than
		 * `'screenaudio'`: a peer running code from before this existed sends a
		 * microphone with no map at all. Classifying that as screen audio would
		 * route real voices onto the screen holder list.
		 *
		 * Alice holds a SCREEN slot and no audio slot, and sends a plain audio
		 * track with the map stripped. If the default were wrong it would sail
		 * through on her screen slot.
		 */
		const { alice, bob, bobAuth, tracksAtBob } = pair({ aliceOmitsTrackMap: true });
		bobAuth.setStage({ video: [], audio: [], screen: [ALICE] });
		alice.setGrant(await grantWith({ video: false, audio: false, screen: true }));

		await alice.addPeer(BOB);
		await bob.addPeer(ALICE);
		await alice.publish('screenaudio', tone());

		await new Promise((resolve) => setTimeout(resolve, 3_000));
		expect(tracksAtBob).toHaveLength(0);

		alice.dispose();
		bob.dispose();
	}, 60_000);

	it('refuses a share’s sound with no share alongside it', async () => {
		/*
		 * `hasRemoteScreen`. It does not close the hole — a patched client can
		 * send a black canvas — but it makes "screen audio rides a share" a
		 * checked invariant rather than a sentence, so the label swap alone is
		 * not enough.
		 */
		const { alice, bob, bobAuth, tracksAtBob } = pair();
		bobAuth.setStage({ video: [], audio: [], screen: [ALICE] });
		alice.setGrant(await grantWith({ video: false, audio: false, screen: true }));

		await alice.addPeer(BOB);
		await bob.addPeer(ALICE);
		// Sound with no picture: nothing in this description declares a share.
		await alice.publish('screenaudio', tone());

		await new Promise((resolve) => setTimeout(resolve, 3_000));
		expect(tracksAtBob).toHaveLength(0);

		alice.dispose();
		bob.dispose();
	}, 60_000);
});

describe('the gate, end to end', () => {
	it('refuses a publisher the receiver does not believe holds a slot', async () => {
		/*
		 * The whole point, assembled: Alice has a validly signed grant and Bob's
		 * own copy of the stage says she holds nothing. Bob's view wins, because
		 * it is read from Postgres under RLS and hers is a claim.
		 */
		const { alice, bob, bobAuth, tracksAtBob } = pair();
		bobAuth.setStage({ video: [], audio: [], screen: [] });
		alice.setGrant(await grantFor(ALICE));

		await alice.addPeer(BOB);
		await bob.addPeer(ALICE);
		await alice.publish('audio', tone());

		// Long enough that a working path would have delivered several times over.
		await new Promise((resolve) => setTimeout(resolve, 4_000));
		expect(tracksAtBob).toHaveLength(0);

		alice.dispose();
		bob.dispose();
	}, 60_000);

	it('refuses an unsigned publisher outright', async () => {
		const { alice, bob, tracksAtBob } = pair();
		// No grant set at all: the ordinary case of a client that never asked.
		await alice.addPeer(BOB);
		await bob.addPeer(ALICE);
		await alice.publish('audio', tone());

		await new Promise((resolve) => setTimeout(resolve, 4_000));
		expect(tracksAtBob).toHaveLength(0);

		alice.dispose();
		bob.dispose();
	}, 60_000);
});

describe('revocation', () => {
	it('tells the publisher to stop the moment a peer leaves the holder list', async () => {
		/*
		 * A revoke must not wait for a renegotiation that may never come, so
		 * pushing the stage down has to REACH the publisher rather than merely
		 * arm the gate against a future offer.
		 *
		 * My first version of this asserted `holds()` was false after `setStage`,
		 * which is true by construction and tests nothing. This asserts the
		 * message actually sent.
		 */
		const { alice, bob, bobAuth, bobSent, tracksAtBob } = pair();
		alice.setGrant(await grantFor(ALICE));
		await alice.addPeer(BOB);
		await bob.addPeer(ALICE);
		await bob.subscribe(ALICE, 'audio', 'low');
		await alice.publish('audio', tone());

		await vi.waitFor(
			() => {
				expect(tracksAtBob.length).toBeGreaterThan(0);
			},
			{ timeout: 20_000, interval: 100 }
		);

		const before = bobSent.length;
		bobAuth.setStage({ video: [], audio: [], screen: [] });
		bob.setStage({ video: [], audio: [], screen: [] });

		// `layer: null` is how "stop sending" reaches a publisher: it collapses
		// unsubscribe and pause into one message and one encoder change.
		await vi.waitFor(
			() => {
				const after = bobSent.slice(before);
				const stop = after.filter(
					(m) =>
						typeof m === 'object' &&
						m !== null &&
						'kind' in m &&
						m.kind === 'want' &&
						'layer' in m &&
						m.layer === null
				);
				expect(stop.length).toBeGreaterThan(0);
			},
			{ timeout: 10_000, interval: 50 }
		);

		alice.dispose();
		bob.dispose();
	}, 60_000);
});

describe('people and tabs', () => {
	it('opens a connection per TAB and reports one peer', async () => {
		/*
		 * One person with two tabs is two connections and one peer. Not an edge
		 * case: the store is per-tab, and pretending otherwise is what makes two
		 * tabs of one person answer the same offer.
		 */
		const TAB_B2 = 'tab-bbbb-2';
		/*
		 * Alice's endpoint sorts LAST here, deliberately: that makes her impolite
		 * to both of Bob's tabs, and the impolite side is the one that opens a
		 * conversation. With an id sorting first she would be polite to everyone,
		 * correctly send nothing, and this test would prove only that.
		 */
		const TAB_ALICE = 'tab-zzzz';
		const endpoints = [
			{ endpoint: TAB_ALICE, actor: ALICE },
			{ endpoint: TAB_B, actor: BOB },
			{ endpoint: TAB_B2, actor: BOB }
		];
		const authorizer = new PublishAuthorizer(ROOM, verifying);
		authorizer.setStage({ video: [ALICE, BOB], audio: [ALICE, BOB], screen: [] });
		const sentTo: string[] = [];
		const alice = new P2PTransport({
			self: TAB_ALICE,
			ice: [],
			authorizer,
			endpoints: () => endpoints,
			send: (to) => sentTo.push(to)
		});

		await alice.addPeer(BOB);
		await alice.publish('audio', tone());

		await vi.waitFor(
			() => {
				expect(new Set(sentTo).size).toBe(2);
			},
			{ timeout: 10_000, interval: 50 }
		);
		expect(new Set(sentTo)).toEqual(new Set([TAB_B, TAB_B2]));

		// ...and both are one peer's worth of stats.
		const stats = await alice.stats();
		expect(stats).toHaveLength(2);
		expect(new Set(stats.map((s) => s.peer))).toEqual(new Set([BOB]));

		alice.dispose();
	}, 60_000);

	it('never connects to its own endpoint', async () => {
		// Our own tab appears in the endpoint list; connecting to it would be a
		// peer connection to ourselves.
		const endpoints = [{ endpoint: TAB_A, actor: ALICE }];
		const authorizer = new PublishAuthorizer(ROOM, verifying);
		const sentTo: string[] = [];
		const alice = new P2PTransport({
			self: TAB_A,
			ice: [],
			authorizer,
			endpoints: () => endpoints,
			send: (to) => sentTo.push(to)
		});
		await alice.addPeer(ALICE);
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(sentTo).toHaveLength(0);
		alice.dispose();
	}, 30_000);

	it('ignores a signal from an endpoint that is not present', async () => {
		// `from` is chosen by the sender, but presence is not. This does not
		// authenticate anyone — it stops a member churning a connection per
		// message at peers who never joined.
		const endpoints = [{ endpoint: TAB_A, actor: ALICE }];
		const authorizer = new PublishAuthorizer(ROOM, verifying);
		const sentTo: string[] = [];
		const alice = new P2PTransport({
			self: TAB_A,
			ice: [],
			authorizer,
			endpoints: () => endpoints,
			send: (to) => sentTo.push(to)
		});
		alice.accept('a-tab-nobody-has-seen', { kind: 'description', type: 'offer', sdp: 'v=0' });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(sentTo).toHaveLength(0);
		expect(await alice.stats()).toHaveLength(0);
		alice.dispose();
	}, 30_000);
});
