import { describe, expect, it, vi } from 'vitest';
import type { IceServer } from '$lib/server/ice';
import type { TransportStats } from '$lib/media/transport';
import { PeerConnection } from './connection';
import { isPolite } from './signal';

/**
 * The TURN relay path, against a real coturn (AR-TRANSPORT-8, AR-COST-9).
 *
 * The one thing in this project that costs money, and until now the only major
 * claim with no evidence behind it whatsoever. Every other media test runs on
 * loopback, where a direct host-to-host path always wins instantly — so the
 * relay code has never executed, `relayed` has only ever reported `false`, and
 * the branch that reports `true` was unreachable by construction.
 *
 * `iceTransportPolicy: 'relay'` fixes that without a second machine: the browser
 * gathers ONLY relay candidates, so a connection that establishes has provably
 * gone out to coturn, been allocated, and come back. Direct paths are not merely
 * unpreferred, they are unavailable.
 *
 * ## What this does and does not prove
 *
 * PROVES: coturn accepts the REST credential scheme this product mints; a TURN
 * allocation succeeds; media flows over the relay; and the stats code correctly
 * reports `relayed: true` from a real report rather than a hand-written one.
 *
 * DOES NOT PROVE: that ~10-15% of real connections need a relay (a property of
 * the internet, not of this code), or that a restrictive NAT behaves the way
 * this simulation does. Those still need production, and AR-TEST-10 still says
 * so.
 *
 * The credentials are computed here rather than fetched from the server, and
 * that keeps the chain closed rather than opening a hole: this file verifies the
 * SCHEME against real coturn, and `ice.spec.ts` verifies our server produces
 * exactly that scheme, checked against an independently computed HMAC. Together
 * they cover the path; neither alone does.
 */

/** Matches the secret coturn is started with. See `pnpm run coturn`. */
const DEV_SECRET = 'mumble-local-turn-secret';
const TURN_URL = 'turn:127.0.0.1:3478';

/** The coturn REST scheme: username is an expiry, credential its HMAC. */
async function relayCredentials(ttlSeconds = 600): Promise<IceServer[]> {
	const username = String(Math.floor(Date.now() / 1000) + ttlSeconds);
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(DEV_SECRET),
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign']
	);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
	let binary = '';
	for (const byte of new Uint8Array(mac)) binary += String.fromCharCode(byte);
	return [{ urls: TURN_URL, username, credential: btoa(binary) }];
}

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

interface Relayed {
	a: PeerConnection;
	b: PeerConnection;
	statsAtA: TransportStats[];
	connected: () => Promise<void>;
}

async function wireOverRelay(): Promise<Relayed> {
	const ENDPOINT_A = 'aaaa-relay';
	const ENDPOINT_B = 'bbbb-relay';
	const ice = await relayCredentials();
	const allow = (): Promise<boolean> => Promise.resolve(true);
	const statsAtA: TransportStats[] = [];
	const statsAtB: TransportStats[] = [];
	const peers: { a?: PeerConnection; b?: PeerConnection } = {};

	const a = new PeerConnection({
		remote: ENDPOINT_B,
		actor: 'actor-b',
		polite: isPolite(ENDPOINT_A, ENDPOINT_B),
		ice,
		relayOnly: true,
		send: (signal) => {
			queueMicrotask(() => {
				void peers.b?.accept(signal);
			});
		},
		onTrack: () => undefined,
		onEnded: () => undefined,
		onState: (stats) => statsAtA.push(stats),
		authorize: allow
	});

	const b = new PeerConnection({
		remote: ENDPOINT_A,
		actor: 'actor-a',
		polite: isPolite(ENDPOINT_B, ENDPOINT_A),
		ice,
		relayOnly: true,
		send: (signal) => {
			queueMicrotask(() => {
				void peers.a?.accept(signal);
			});
		},
		onTrack: () => undefined,
		onEnded: () => undefined,
		onState: (stats) => statsAtB.push(stats),
		authorize: allow
	});

	peers.a = a;
	peers.b = b;
	// Explicitly, exactly as `P2PTransport.connect` does. Leaving it to the
	// data channel's `onnegotiationneeded` is what the transport stopped relying
	// on, and a test should exercise the path the product takes.
	a.prewarm();
	b.prewarm();

	const connected = async (): Promise<void> => {
		await vi.waitFor(
			() => {
				expect(statsAtA.some((s) => s.state === 'connected')).toBe(true);
				expect(statsAtB.some((s) => s.state === 'connected')).toBe(true);
			},
			{ timeout: 30_000, interval: 200 }
		);
	};

	return { a, b, statsAtA, connected };
}

describe('a connection that is forced through TURN', () => {
	it('establishes, which means coturn accepted our credentials', async () => {
		/*
		 * The credential is the interesting half. coturn refuses an allocation
		 * whose HMAC does not match, so a connection at all is proof the REST
		 * scheme is right — expiry-as-username, base64 HMAC-SHA1 as password.
		 * Until now that scheme was verified only against our own arithmetic.
		 */
		const { a, connected } = await wireOverRelay();
		a.send('audio', tone());
		await connected();
		a.close();
	}, 60_000);

	it('reports relayed: true — the branch loopback can never reach', async () => {
		/*
		 * AR-COST-9 calls the relay fraction the single number worth watching,
		 * because it is the only media spend a P2P product carries. It is derived
		 * from the nominated candidate pair, and every previous test has seen that
		 * pair be host-to-host. This is the first time the `true` side of that
		 * branch has executed against a report a browser actually produced.
		 */
		const { a, connected } = await wireOverRelay();
		a.send('audio', tone());
		await connected();

		await vi.waitFor(
			async () => {
				const stats = await a.stats();
				expect(stats.relayed).toBe(true);
			},
			{ timeout: 30_000, interval: 500 }
		);

		a.close();
	}, 60_000);

	it('refuses to connect when the credentials are wrong', async () => {
		/*
		 * The control, and the test that makes the two above mean something. If a
		 * relay-only connection established regardless of the credential, all this
		 * would prove is that two peers on one machine can find each other — which
		 * they can, and which is exactly what `relay` is meant to prevent.
		 */
		const ENDPOINT_A = 'aaaa-bad';
		const ENDPOINT_B = 'bbbb-bad';
		const bad: IceServer[] = [
			{ urls: TURN_URL, username: '9999999999', credential: 'not-the-right-hmac' }
		];
		const allow = (): Promise<boolean> => Promise.resolve(true);
		const statesA: TransportStats[] = [];
		const peers: { a?: PeerConnection; b?: PeerConnection } = {};

		const a = new PeerConnection({
			remote: ENDPOINT_B,
			actor: 'actor-b',
			polite: isPolite(ENDPOINT_A, ENDPOINT_B),
			ice: bad,
			relayOnly: true,
			send: (signal) => {
				queueMicrotask(() => {
					void peers.b?.accept(signal);
				});
			},
			onTrack: () => undefined,
			onEnded: () => undefined,
			onState: (stats) => statesA.push(stats),
			authorize: allow
		});
		const b = new PeerConnection({
			remote: ENDPOINT_A,
			actor: 'actor-a',
			polite: isPolite(ENDPOINT_B, ENDPOINT_A),
			ice: bad,
			relayOnly: true,
			send: (signal) => {
				queueMicrotask(() => {
					void peers.a?.accept(signal);
				});
			},
			onTrack: () => undefined,
			onEnded: () => undefined,
			onState: () => undefined,
			authorize: allow
		});
		peers.a = a;
		peers.b = b;
		a.prewarm();
		b.prewarm();
		a.send('audio', tone());

		// Long enough that a working allocation would have completed many times.
		await new Promise((resolve) => setTimeout(resolve, 12_000));
		expect(statesA.some((s) => s.state === 'connected')).toBe(false);

		a.close();
		b.close();
	}, 60_000);
});
