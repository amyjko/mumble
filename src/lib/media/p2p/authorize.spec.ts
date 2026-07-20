import { beforeAll, describe, expect, it } from 'vitest';
import { signGrant, type Grant, type GrantBody } from '$lib/media/grant';
import { PublishAuthorizer } from './authorize';

/**
 * The receiver-side gate. This is where UX-STAGE-6 stops being a convention.
 *
 * Real ECDSA keys, no mocks: a test that stubs verification would pass while the
 * thing it is testing did nothing, which is the failure mode this file exists to
 * rule out.
 */

const ROOM = '11111111-1111-4111-8111-111111111111';
const OTHER_ROOM = '99999999-9999-4999-8999-999999999999';
const PEER = '22222222-2222-4222-8222-222222222222';
const IMPOSTOR = '33333333-3333-4333-8333-333333333333';
const NOW = 1_800_000_000;

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

function body(over: Partial<GrantBody> = {}): GrantBody {
	return {
		room: ROOM,
		peer: PEER,
		publish: { video: true, audio: true },
		stage: 10,
		iat: NOW,
		exp: NOW + 120,
		...over
	};
}

async function grantFor(over: Partial<GrantBody> = {}): Promise<Grant> {
	return signGrant(body(over), signing);
}

/** An authorizer that believes PEER holds both slots. */
function authorizer(): PublishAuthorizer {
	const gate = new PublishAuthorizer(ROOM, verifying);
	gate.setStage({ video: [PEER], audio: [PEER] });
	return gate;
}

describe('what gets through', () => {
	it('accepts a valid grant from a current holder', async () => {
		expect(await authorizer().allows(await grantFor(), PEER, ['video'], NOW)).toBe(true);
	});

	it('needs no grant for an offer that sends nothing', async () => {
		// A pre-warmed connection (AR-TRANSPORT-9) carries no track yet, and a
		// receiver asking to be sent to is not publishing.
		expect(await authorizer().allows(undefined, PEER, [], NOW)).toBe(true);
	});
});

describe('what does not', () => {
	it('refuses an offer with no grant at all', async () => {
		expect(await authorizer().allows(undefined, PEER, ['video'], NOW)).toBe(false);
	});

	it('refuses a grant signed by somebody else', async () => {
		const stranger = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
			'sign',
			'verify'
		]);
		const forged = await signGrant(body(), stranger.privateKey);
		expect(await authorizer().allows(forged, PEER, ['video'], NOW)).toBe(false);
	});

	it('refuses a grant for another room', async () => {
		expect(await authorizer().allows(await grantFor({ room: OTHER_ROOM }), PEER, ['video'], NOW)).toBe(
			false
		);
	});

	it('refuses a grant naming a different peer', async () => {
		/*
		 * The impersonation case, and the reason the grant is signed at all. The
		 * channel proves a sender belongs to the room; it does not prove who they
		 * are, so an admitted member can relay somebody else's valid grant and
		 * claim to be them.
		 */
		const gate = new PublishAuthorizer(ROOM, verifying);
		gate.setStage({ video: [PEER, IMPOSTOR], audio: [] });
		expect(await gate.allows(await grantFor(), IMPOSTOR, ['video'], NOW)).toBe(false);
	});

	it('refuses an expired grant', async () => {
		expect(await authorizer().allows(await grantFor(), PEER, ['video'], NOW + 121)).toBe(false);
	});

	it('refuses a kind the grant does not cover', async () => {
		const audioOnly = await grantFor({ publish: { video: false, audio: true } });
		expect(await authorizer().allows(audioOnly, PEER, ['video'], NOW)).toBe(false);
	});

	it('refuses when ANY requested kind fails', async () => {
		// An offer adding both tracks must be refused whole, not answered with
		// the half that happened to be authorized.
		const audioOnly = await grantFor({ publish: { video: false, audio: true } });
		expect(await authorizer().allows(audioOnly, PEER, ['audio', 'video'], NOW)).toBe(false);
	});
});

describe('the live holder list', () => {
	it('refuses a perfectly valid grant from someone no longer holding the slot', async () => {
		/*
		 * THE clause that makes authorization current rather than merely genuine.
		 * The grant is signed, unexpired, and names the right room and peer — it
		 * is simply out of date, and only the receiver's own copy of the stage
		 * knows that.
		 */
		const gate = new PublishAuthorizer(ROOM, verifying);
		gate.setStage({ video: [], audio: [] });
		expect(await gate.allows(await grantFor(), PEER, ['video'], NOW)).toBe(false);
	});

	it('follows a revoke that happens after the grant was accepted', async () => {
		// Revocation must not wait for a renegotiation that may never come.
		const gate = authorizer();
		expect(await gate.allows(await grantFor(), PEER, ['video'], NOW)).toBe(true);
		gate.setStage({ video: [], audio: [] });
		expect(gate.holds(PEER, 'video')).toBe(false);
		expect(await gate.allows(await grantFor(), PEER, ['video'], NOW)).toBe(false);
	});

	it('distinguishes the two kinds', async () => {
		const gate = new PublishAuthorizer(ROOM, verifying);
		gate.setStage({ video: [], audio: [PEER] });
		expect(await gate.allows(await grantFor(), PEER, ['audio'], NOW)).toBe(true);
		expect(await gate.allows(await grantFor(), PEER, ['video'], NOW)).toBe(false);
	});
});

describe('replay', () => {
	it('refuses a grant older than one already accepted from that peer', async () => {
		const gate = authorizer();
		expect(await gate.allows(await grantFor({ stage: 20 }), PEER, ['video'], NOW)).toBe(true);
		// Captured earlier and replayed after a revoke-and-regrant cycle.
		expect(await gate.allows(await grantFor({ stage: 19 }), PEER, ['video'], NOW)).toBe(false);
	});

	it('still accepts the same grant twice', async () => {
		// One grant legitimately covers video and audio, and any renegotiation
		// inside its TTL. Refusing that would break honest peers.
		const gate = authorizer();
		const g = await grantFor({ stage: 20 });
		expect(await gate.allows(g, PEER, ['video'], NOW)).toBe(true);
		expect(await gate.allows(g, PEER, ['audio'], NOW)).toBe(true);
	});

	it('does not let a REFUSED grant raise the bar', async () => {
		/*
		 * Subtle, and worth a test: if the high-water mark were recorded before
		 * the other clauses ran, a peer could send a wrong-room grant with a huge
		 * stage and lock themselves out of every honest grant afterwards — a
		 * self-inflicted denial of service that would look like "video sometimes
		 * doesn't connect".
		 */
		const gate = authorizer();
		expect(await gate.allows(await grantFor({ room: OTHER_ROOM, stage: 9999 }), PEER, ['video'], NOW)).toBe(
			false
		);
		expect(await gate.allows(await grantFor({ stage: 10 }), PEER, ['video'], NOW)).toBe(true);
	});

	it('tracks peers separately', async () => {
		const gate = new PublishAuthorizer(ROOM, verifying);
		gate.setStage({ video: [PEER, IMPOSTOR], audio: [] });
		expect(await gate.allows(await grantFor({ stage: 500 }), PEER, ['video'], NOW)).toBe(true);
		// A busy peer must not make a quiet one's low-numbered grant unusable.
		const other = await signGrant(body({ peer: IMPOSTOR, stage: 11 }), signing);
		expect(await gate.allows(other, IMPOSTOR, ['video'], NOW)).toBe(true);
	});

	it('forgets a peer so a rejoin starts clean', async () => {
		const gate = authorizer();
		expect(await gate.allows(await grantFor({ stage: 50 }), PEER, ['video'], NOW)).toBe(true);
		gate.forget(PEER);
		expect(await gate.allows(await grantFor({ stage: 10 }), PEER, ['video'], NOW)).toBe(true);
	});
});
