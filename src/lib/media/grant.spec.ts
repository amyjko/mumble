import { describe, expect, it } from 'vitest';
import {
	GRANT_ALGORITHM,
	grantAllows,
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
		publish: { video: true, audio: true },
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
		const grant = await signGrant(body({ publish: { video: false, audio: false } }), pair.privateKey);

		// Re-encode a body that grants video, keeping the original signature.
		const tampered: Grant = {
			body: btoa(JSON.stringify(body({ publish: { video: true, audio: true } })))
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
		expect(grantAllows(body(), { room: ROOM, peer: PEER, kind: 'video' })).toBe(true);
	});

	it('refuses a grant for another room', () => {
		// A valid grant is a real thing an attacker holds — for THEIR room.
		expect(grantAllows(body(), { room: OTHER, peer: PEER, kind: 'video' })).toBe(false);
	});

	it('refuses a grant naming another peer', () => {
		expect(grantAllows(body(), { room: ROOM, peer: OTHER, kind: 'video' })).toBe(false);
	});

	it('refuses a kind it does not cover', () => {
		// Muted, or audio-only: holding one does not imply the other.
		const audioOnly = body({ publish: { video: false, audio: true } });
		expect(grantAllows(audioOnly, { room: ROOM, peer: PEER, kind: 'audio' })).toBe(true);
		expect(grantAllows(audioOnly, { room: ROOM, peer: PEER, kind: 'video' })).toBe(false);
	});
});
