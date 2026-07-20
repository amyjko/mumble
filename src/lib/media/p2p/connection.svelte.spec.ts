import { describe, expect, it, vi } from 'vitest';
import type { Grant } from '$lib/media/grant';
import type { MediaKind, RemoteTrack, TransportStats } from '$lib/media/transport';
import { PeerConnection } from './connection';
import { isPolite } from './signal';
import type { Signal } from './signal';

/**
 * Two real peer connections, in one page (AR-TRANSPORT-1).
 *
 * The keystone test of the media plane, and deliberately NOT an end-to-end one.
 * Everything that matters about negotiation — collision handling, the publish
 * gate, candidate ordering — is decided inside these objects, and asserting it
 * here gives real `RTCPeerConnection`s, real SDP and real ICE in about a second,
 * with no Supabase, no fixtures and no camera permission. A cross-context E2E
 * would prove strictly less and take fifty times longer.
 *
 * The track is an oscillator rather than a camera: `getUserMedia` is a banned
 * name outside this directory, headless has no compositor so a canvas capture is
 * unreliable, and an oscillator is deterministic and needs no permission.
 *
 * What this CANNOT prove is in AR-TEST-10 and worth restating: both ends are on
 * loopback, so only host candidates are exercised, no relay path exists, and ICE
 * completes in a single round trip. A timing bug that needs a slow gathering
 * phase is invisible here — which is exactly why candidate buffering has a test
 * of its own below rather than being left to chance.
 */

/** A deterministic, permission-free audio track. */
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

interface Wired {
	a: PeerConnection;
	b: PeerConnection;
	tracksAtB: RemoteTrack[];
	statesAtB: TransportStats[];
	/** Resolves when both ends report connected. */
	connected: () => Promise<void>;
}

/**
 * Wire two connections to each other through an async hop.
 *
 * Async on purpose: delivering synchronously would let a signal arrive inside
 * the call that produced it, which no real transport does and which hides
 * re-entrancy bugs.
 */
function wire(
	options: {
		authorizeA?: (grant: Grant | undefined, kinds: readonly MediaKind[]) => Promise<boolean>;
		authorizeB?: (grant: Grant | undefined, kinds: readonly MediaKind[]) => Promise<boolean>;
		/** Hold B's descriptions back so its candidates reach A first. */
		delayDescriptionsToA?: boolean;
	} = {}
): Wired {
	const ENDPOINT_A = 'aaaa-endpoint';
	const ENDPOINT_B = 'bbbb-endpoint';
	const allow = (): Promise<boolean> => Promise.resolve(true);

	const tracksAtB: RemoteTrack[] = [];
	const statesAtB: TransportStats[] = [];
	const statesAtA: TransportStats[] = [];

	// A holder, because the two reference each other: each one's `send` reaches
	// the other, and neither exists when the first is constructed.
	const peers: { a?: PeerConnection; b?: PeerConnection } = {};
	/** Held back so candidates can overtake the description they belong to. */
	const heldDescriptions: Signal[] = [];
	let descriptionDelivered = false;

	const a = new PeerConnection({
		remote: ENDPOINT_B,
		actor: 'actor-b',
		polite: isPolite(ENDPOINT_A, ENDPOINT_B),
		ice: [],
		send: (signal) => {
			queueMicrotask(() => {
				void peers.b?.accept(signal);
			});
		},
		onTrack: () => undefined,
		onEnded: () => undefined,
		onState: (stats) => statesAtA.push(stats),
		authorize: options.authorizeA ?? allow
	});

	const b = new PeerConnection({
		remote: ENDPOINT_A,
		actor: 'actor-a',
		polite: isPolite(ENDPOINT_B, ENDPOINT_A),
		ice: [],
		send: (signal) => {
			/*
			 * The ordering loopback will not produce on its own: candidates
			 * OVERTAKING the description they belong to. Descriptions are held
			 * for a beat while candidates go straight through, so A is asked to
			 * add candidates before it has any remote description.
			 */
			if (options.delayDescriptionsToA === true) {
				if (signal.kind === 'description') {
					heldDescriptions.push(signal);
					setTimeout(() => {
						const next = heldDescriptions.shift();
						if (next !== undefined) {
							void peers.a?.accept(next);
							// From here on B's candidates are DROPPED. The early ones
							// are the only ones A will ever have, so the connection can
							// only complete if they were buffered rather than refused.
							descriptionDelivered = true;
						}
					}, 250);
					return;
				}
				if (signal.kind === 'candidates' && descriptionDelivered) return;
			}
			queueMicrotask(() => {
				void peers.a?.accept(signal);
			});
		},
		onTrack: (track) => tracksAtB.push(track),
		onEnded: () => undefined,
		onState: (stats) => statesAtB.push(stats),
		authorize: options.authorizeB ?? allow
	});

	const connected = async (): Promise<void> => {
		await vi.waitFor(
			() => {
				const okA = statesAtA.some((s) => s.state === 'connected');
				const okB = statesAtB.some((s) => s.state === 'connected');
				expect(okA && okB).toBe(true);
			},
			{ timeout: 15_000, interval: 100 }
		);
	};

	peers.a = a;
	peers.b = b;
	return { a, b, tracksAtB, statesAtB, connected };
}

describe('a connection between two peers', () => {
	it('negotiates, connects, and delivers the track', async () => {
		const { a, tracksAtB, connected } = wire();
		a.send('audio', tone());
		await connected();
		await vi.waitFor(
			() => {
				expect(tracksAtB.length).toBeGreaterThan(0);
			},
			{ timeout: 15_000, interval: 100 }
		);
		expect(tracksAtB[0]?.kind).toBe('audio');
		// Reported as the ACTOR at the far end, never as the tab: the seam above
		// speaks people. `b` is B's connection, so its remote is A.
		expect(tracksAtB[0]?.peer).toBe('actor-a');
		a.close();
	}, 40_000);

	it('reports stats once media is flowing', async () => {
		const { a, connected } = wire();
		a.send('audio', tone());
		await connected();
		const stats = await a.stats();
		expect(stats.state).toBe('connected');
		// Loopback: a direct pair, never a relay. If this ever reports true
		// locally, the relay-detection logic is wrong rather than the network.
		expect(stats.relayed).toBe(false);
		a.close();
	}, 40_000);
});

describe('the publish gate', () => {
	it('refuses an unauthorized offer: no track, connection closed', async () => {
		/*
		 * THE test that turns UX-STAGE-6 from a convention into a fact.
		 *
		 * B refuses everything. A is a peer who believes it may publish and is
		 * wrong — the case where a patched client, or one whose slot was revoked
		 * between the grant and the offer, tries to be seen anyway.
		 */
		const refuse = vi.fn<(g: Grant | undefined, k: readonly MediaKind[]) => Promise<boolean>>(() =>
			Promise.resolve(false)
		);
		const { a, tracksAtB, statesAtB } = wire({ authorizeB: refuse });
		a.send('audio', tone());

		await vi.waitFor(
			() => {
				expect(refuse).toHaveBeenCalled();
			},
			{ timeout: 15_000, interval: 100 }
		);

		// It was judged on the kinds derived from the SDP, not on anything the
		// sender declared about itself.
		expect(refuse.mock.calls[0]?.[1]).toEqual(['audio']);

		// No media, ever — and the connection is closed rather than left half
		// open for a retry to slip through.
		await vi.waitFor(
			() => {
				expect(statesAtB.some((s) => s.state === 'closed')).toBe(true);
			},
			{ timeout: 15_000, interval: 100 }
		);
		expect(tracksAtB).toHaveLength(0);
		a.close();
	}, 40_000);

	it('lets a pre-warmed connection through with no grant at all', async () => {
		/*
		 * AR-TRANSPORT-9: the connection is established a beat BEFORE anything is
		 * sent over it, so the first offer carries no media and must not need
		 * authorizing — a lurker opening a connection is not publishing.
		 *
		 * This asserts the FIRST call specifically. Later calls carry ['audio']
		 * once a track is added, and asserting inside the gate on every call
		 * (which is what I wrote first) fails on the second one.
		 */
		// Asserted on A's gate, because the IMPOLITE side is the one that opens the
		// conversation: B pre-warms and offers, so A is who judges that offer.
		const gate = vi.fn<(g: Grant | undefined, k: readonly MediaKind[]) => Promise<boolean>>(() =>
			Promise.resolve(true)
		);
		const { a, connected } = wire({ authorizeA: gate });
		await connected();
		expect(gate).toHaveBeenCalled();
		expect(gate.mock.calls[0]?.[1]).toEqual([]);
		// ...and no grant was demanded for it.
		expect(gate.mock.calls[0]?.[0]).toBeUndefined();
		a.close();
	}, 40_000);
});

describe('ordering that loopback will not produce', () => {
	it('buffers candidates that arrive before their description', async () => {
		/*
		 * `addIceCandidate` rejects when there is no remote description, and on
		 * one machine ICE finishes so fast the race effectively never happens —
		 * the archetypal bug that passes locally forever and fails on a real
		 * network. So the ordering is created deliberately: B's descriptions are
		 * held for a beat while its candidates go straight through.
		 *
		 * This asserts the MECHANISM, not its consequence, and that is a
		 * deliberate retreat rather than a shortcut. Two earlier versions asserted
		 * that the connection still established, and both passed with the buffer
		 * removed: ICE learns peer-reflexive candidates from incoming connectivity
		 * checks, so a peer on loopback connects perfectly well having received no
		 * signalled candidates at all. There is no black-box assertion available
		 * here that distinguishes buffered from discarded — that distinction needs
		 * a real network, and AR-TEST-10 records it as untested.
		 */
		const { a, connected } = wire({ delayDescriptionsToA: true });
		a.send('audio', tone());

		// Candidates arrived with nowhere to go, and were kept.
		await vi.waitFor(
			() => {
				expect(a.bufferedCandidateCount).toBeGreaterThan(0);
			},
			{ timeout: 15_000, interval: 20 }
		);

		// ...and were flushed once the description they belong to arrived.
		await vi.waitFor(
			() => {
				expect(a.bufferedCandidateCount).toBe(0);
			},
			{ timeout: 15_000, interval: 50 }
		);

		await connected();
		a.close();
	}, 40_000);
});

describe('politeness', () => {
	it('resolves a simultaneous renegotiation into one connection', async () => {
		// Two people unmuting together is enough to cause this. Exactly one side
		// must yield; if both roll back or neither does, nothing connects.
		const { a, b, connected } = wire();
		a.send('audio', tone());
		b.send('audio', tone());
		await connected();
		a.close();
	}, 40_000);
});
