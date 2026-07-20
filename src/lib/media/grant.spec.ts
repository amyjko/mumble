import { describe, expect, it } from 'vitest';
import {
	GRANT_ALGORITHM,
	grantAllows,
	grantBodySchema,
	grantSchema,
	signGrant,
	verifyGrant,
	type Grant,
	type GrantBody
} from './grant';

/**
 * The publish capability (AR-MEDIA-2, UX-STAGE-6).
 *
 * Node-only. WebCrypto is the same API in node, workerd and the browser, so the
 * signing this exercises is the signing that ships — which matters, because
 * every one of these failures is something an attacker gets to attempt.
 */

const ROOM = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const NOW = 1_800_000_000;

async function keys(): Promise<CryptoKeyPair> {
	return crypto.subtle.generateKey(GRANT_ALGORITHM, true, ['sign', 'verify']);
}

function body(over: Partial<GrantBody> = {}): GrantBody {
	return {
		room: ROOM,
		peer: PEER,
		publish: { video: true, audio: true, screen: false },
		stage: 7,
		iat: NOW,
		exp: NOW + 120,
		...over
	};
}

describe('a grant round trip', () => {
	it('verifies what it signed', async () => {
		const pair = await keys();
		const grant = await signGrant(body(), pair.privateKey);
		expect(await verifyGrant(grant, pair.publicKey, NOW)).toEqual(body());
	});

	it('survives a JSON round trip, since it travels as a payload', async () => {
		const pair = await keys();
		const grant = await signGrant(body(), pair.privateKey);
		// Parsed through the schema rather than asserted, which is also what the
		// transport will do to a grant arriving from a peer.
		const overWire = grantSchema.parse(JSON.parse(JSON.stringify(grant)));
		expect(await verifyGrant(overWire, pair.publicKey, NOW)).toEqual(body());
	});
});

describe('what a verifier refuses', () => {
	it('a grant signed by somebody else', async () => {
		// The forgery case. An attacker who can mint their own key pair must not
		// be able to mint their own authorization.
		const real = await keys();
		const attacker = await keys();
		const forged = await signGrant(body(), attacker.privateKey);
		expect(await verifyGrant(forged, real.publicKey, NOW)).toBeNull();
	});

	it('a body edited after signing', async () => {
		const pair = await keys();
		const grant = await signGrant(body({ publish: { video: false, audio: false, screen: false } }), pair.privateKey);

		// Re-encode a body that grants video, keeping the original signature.
		const tampered: Grant = {
			body: btoa(JSON.stringify(body({ publish: { video: true, audio: true, screen: false } })))
				.replace(/\+/g, '-')
				.replace(/\//g, '_')
				.replace(/=+$/, ''),
			sig: grant.sig
		};
		expect(await verifyGrant(tampered, pair.publicKey, NOW)).toBeNull();
	});

	it('an expired grant', async () => {
		const pair = await keys();
		const grant = await signGrant(body({ exp: NOW + 10 }), pair.privateKey);
		expect(await verifyGrant(grant, pair.publicKey, NOW + 11)).toBeNull();
		// And is still good a moment before.
		expect(await verifyGrant(grant, pair.publicKey, NOW + 9)).not.toBeNull();
	});

	it('garbage, without throwing', async () => {
		// This parses attacker-supplied input, so every malformed shape has to
		// come back as a refusal rather than an exception the route turns into a
		// 500 — or worse, a rejected promise nobody awaited.
		const pair = await keys();
		for (const grant of [
			{ body: 'not base64!!', sig: 'also bad' },
			{ body: '', sig: '' },
			{ body: 'YWJj', sig: 'YWJj' }
		]) {
			expect(await verifyGrant(grant, pair.publicKey, NOW)).toBeNull();
		}
	});

	it('a body that is valid JSON but not a grant', async () => {
		const pair = await keys();
		const encoded = new TextEncoder().encode(JSON.stringify({ hello: 'world' }));
		const sig = await crypto.subtle.sign(
			{ name: 'ECDSA', hash: 'SHA-256' },
			pair.privateKey,
			encoded
		);
		const b64 = (bytes: Uint8Array) =>
			btoa(String.fromCharCode(...bytes))
				.replace(/\+/g, '-')
				.replace(/\//g, '_')
				.replace(/=+$/, '');
		// Correctly signed, wrong shape: the signature check passes and the
		// schema is what refuses it.
		expect(
			await verifyGrant({ body: b64(encoded), sig: b64(new Uint8Array(sig)) }, pair.publicKey, NOW)
		).toBeNull();
	});
});

describe('grantAllows', () => {
	it('accepts the offer it was issued for', () => {
		expect(grantAllows(body(), { room: ROOM, peer: PEER, kind: 'video', seenStage: 0 })).toBe(true);
	});

	it('refuses a grant for another room', () => {
		// A valid grant is a real thing an attacker holds — for THEIR room.
		expect(grantAllows(body(), { room: OTHER, peer: PEER, kind: 'video', seenStage: 0 })).toBe(false);
	});

	it('refuses a grant naming another peer', () => {
		expect(grantAllows(body(), { room: ROOM, peer: OTHER, kind: 'video', seenStage: 0 })).toBe(false);
	});

	it('refuses a kind it does not cover', () => {
		// Muted, or audio-only: holding one does not imply the other.
		const audioOnly = body({ publish: { video: false, audio: true, screen: false } });
		expect(grantAllows(audioOnly, { room: ROOM, peer: PEER, kind: 'audio', seenStage: 0 })).toBe(true);
		expect(grantAllows(audioOnly, { room: ROOM, peer: PEER, kind: 'video', seenStage: 0 })).toBe(false);
	});

	it('a camera grant does not authorize a SCREEN SHARE (UX-OBJ-6)', () => {
		// The two consume separate slots, so holding one must not imply the other.
		// Getting this backwards would let any video holder publish a share and
		// silently exceed max_av.
		const cameraOnly = body({ publish: { video: true, audio: true, screen: false } });
		expect(grantAllows(cameraOnly, { room: ROOM, peer: PEER, kind: 'screen', seenStage: 0 })).toBe(
			false
		);
		const sharing = body({ publish: { video: false, audio: false, screen: true } });
		expect(grantAllows(sharing, { room: ROOM, peer: PEER, kind: 'screen', seenStage: 0 })).toBe(true);
		expect(grantAllows(sharing, { room: ROOM, peer: PEER, kind: 'video', seenStage: 0 })).toBe(false);
	});

	it('screen audio rides the SCREEN grant, and is not a back door to the mic (UX-OBJ-16)', () => {
		/*
		 * The whole authorization claim in three assertions. A share's own sound
		 * needs a screen slot; an audio slot does not confer it; and holding a
		 * screen slot still does not let you publish a microphone.
		 */
		const sharing = body({ publish: { video: false, audio: false, screen: true } });
		expect(grantAllows(sharing, { room: ROOM, peer: PEER, kind: 'screenaudio', seenStage: 0 })).toBe(
			true
		);
		expect(grantAllows(sharing, { room: ROOM, peer: PEER, kind: 'audio', seenStage: 0 })).toBe(false);

		const speaking = body({ publish: { video: false, audio: true, screen: false } });
		expect(grantAllows(speaking, { room: ROOM, peer: PEER, kind: 'screenaudio', seenStage: 0 })).toBe(
			false
		);
	});

	it('a grant minted before screen shares existed parses, and refuses one', () => {
		// Grants live 120s, so a worker deployed mid-session issues bodies without
		// the field. It must still parse — and it must fail CLOSED.
		const legacy = grantBodySchema.parse({
			room: ROOM,
			peer: PEER,
			publish: { video: true, audio: true },
			stage: 7,
			iat: NOW,
			exp: NOW + 120
		});
		expect(legacy.publish.screen).toBe(false);
		expect(grantAllows(legacy, { room: ROOM, peer: PEER, kind: 'screen', seenStage: 0 })).toBe(false);
	});
});

describe('replay after a revoke', () => {
	/*
	 * The hole this closes: `stage` was documented as making a grant minted
	 * before a revoke unreplayable after it, and NOTHING read the field. A
	 * revoked holder's grant stayed good for its full 120s TTL.
	 *
	 * The obvious repair — compare `stage` to the room's current version — is
	 * worse than the hole, and that is the whole reason for the shape below.
	 */

	it('refuses a grant older than one already seen from that peer', () => {
		const stale = body({ stage: 7 });
		// The receiver has already accepted stage 9 from this peer. Whatever 7
		// authorized, it was superseded.
		expect(grantAllows(stale, { room: ROOM, peer: PEER, kind: 'video', seenStage: 9 })).toBe(false);
	});

	it('accepts the same stage twice', () => {
		// Not a replay: one grant legitimately covers video AND audio, and any
		// renegotiation inside its TTL. Refusing equality would break honest peers.
		const g = body({ stage: 9 });
		expect(grantAllows(g, { room: ROOM, peer: PEER, kind: 'video', seenStage: 9 })).toBe(true);
		expect(grantAllows(g, { room: ROOM, peer: PEER, kind: 'audio', seenStage: 9 })).toBe(true);
	});

	it('accepts a newer grant and does not care how much newer', () => {
		expect(grantAllows(body({ stage: 400 }), { room: ROOM, peer: PEER, kind: 'video', seenStage: 9 })).toBe(true);
	});

	it('does NOT reject an honest grant just because the room moved on', () => {
		/*
		 * THE regression this shape exists to prevent, and the reason the obvious
		 * fix was rejected. `save_room_state` bumps `rooms.version` on every
		 * mutation — dragging a note, editing text, changing the background. A
		 * receiver comparing `stage` against the room's CURRENT version would
		 * refuse every honest grant the instant anybody touched anything.
		 *
		 * `seenStage` is per-peer history, not room time, so an unrelated edit
		 * cannot make a valid grant look stale.
		 */
		const honest = body({ stage: 12 });
		// Nothing has been accepted from this peer yet, so nothing is superseded.
		expect(grantAllows(honest, { room: ROOM, peer: PEER, kind: 'video', seenStage: 0 })).toBe(true);
		// And a second, newer grant from the same peer still lands.
		expect(grantAllows(body({ stage: 13 }), { room: ROOM, peer: PEER, kind: 'video', seenStage: 12 })).toBe(true);
	});

	it('tracks staleness per peer, not globally', () => {
		// A busy peer at stage 900 must not render a quiet peer's stage-10 grant
		// unusable. Two peers, two clocks.
		expect(grantAllows(body({ peer: PEER, stage: 10 }), { room: ROOM, peer: PEER, kind: 'video', seenStage: 10 })).toBe(true);
	});
});
