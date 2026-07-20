import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ICE server minting (AR-TRANSPORT-8, AR-DEPLOY-6).
 *
 * This file exists because of a gap CI exposed. `iceServers` had no unit test
 * at all — the only thing exercising it was an E2E that runs with TURN unset,
 * so it covered exactly one of the two branches and none of the credential
 * arithmetic. AR-TEST-10 records that the *relay path* cannot be tested locally,
 * and that is true: there is no relay here. But minting a credential is pure
 * crypto, and "we can't test the relay" was quietly excusing "we don't test the
 * secret handling either". These are different claims.
 *
 * The environment is mocked rather than set, because `$env/dynamic/private` is
 * typed from whatever `.env` held at build time — the same build-time-vs-runtime
 * confusion that broke CI in the first place.
 */

const env: Record<string, string | undefined> = {};

vi.mock('$env/dynamic/private', () => ({ env }));

const { iceServers } = await import('./ice');

beforeEach(() => {
	env['TURN_SHARED_SECRET'] = undefined;
	env['TURN_URLS'] = undefined;
});

/** The credential, computed independently of the implementation. */
async function expectedCredential(secret: string, username: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign']
	);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
	let binary = '';
	for (const byte of new Uint8Array(mac)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

describe('with no TURN configured', () => {
	it('returns STUN only', async () => {
		const servers = await iceServers();
		expect(servers).toHaveLength(1);
		expect(servers[0]?.urls).toContain('stun:');
		// No credential is the point: nothing to leak, and nothing that costs.
		expect(servers[0]?.credential).toBeUndefined();
	});

	it('treats a blank value as absent', async () => {
		/*
		 * Not hypothetical, and the reason this test exists. `.env.example` ships
		 * these names with EMPTY values so deployers know what to set — so every
		 * environment built from it has the variables present and blank. Reading
		 * that as "TURN is configured" would mint credentials under an empty
		 * secret and hand clients a relay URL of "".
		 */
		env['TURN_SHARED_SECRET'] = '';
		env['TURN_URLS'] = '';
		expect(await iceServers()).toHaveLength(1);

		env['TURN_SHARED_SECRET'] = '   \n';
		env['TURN_URLS'] = '  ';
		expect(await iceServers()).toHaveLength(1);
	});

	it('refuses a half-configuration rather than guessing', async () => {
		env['TURN_SHARED_SECRET'] = 'secret';
		expect(await iceServers()).toHaveLength(1);

		env['TURN_SHARED_SECRET'] = undefined;
		env['TURN_URLS'] = 'turn:relay.example:3478';
		// A relay URL with no credential would be offered to the browser and fail
		// every allocation. STUN-only is the honest answer.
		expect(await iceServers()).toHaveLength(1);
	});
});

describe('with TURN configured', () => {
	beforeEach(() => {
		env['TURN_SHARED_SECRET'] = 'a-shared-secret';
		env['TURN_URLS'] = 'turn:relay.example:3478';
	});

	it('puts STUN first, so a direct path is preferred over one that costs money', async () => {
		const servers = await iceServers();
		expect(servers).toHaveLength(2);
		expect(servers[0]?.urls).toContain('stun:');
		expect(servers[1]?.urls).toEqual(['turn:relay.example:3478']);
	});

	it('mints a coturn REST credential the relay would actually accept', async () => {
		const before = Math.floor(Date.now() / 1000);
		const servers = await iceServers(600);
		const relay = servers[1];

		// The username IS the expiry, which is the whole scheme.
		const username = relay?.username ?? '';
		const expiry = Number(username);
		expect(expiry).toBeGreaterThanOrEqual(before + 600);
		expect(expiry).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 600);

		// Computed here from the secret, not copied from the implementation: a
		// credential that is merely present would pass a truthiness check and be
		// rejected by every real relay.
		expect(relay?.credential).toBe(await expectedCredential('a-shared-secret', username));
	});

	it('honours the requested lifetime', async () => {
		const short = await iceServers(60);
		const long = await iceServers(3600);
		expect(Number(long[1]?.username) - Number(short[1]?.username)).toBeGreaterThanOrEqual(3500);
	});

	it('binds the credential to the secret', async () => {
		// If the secret were ignored, this would still produce a valid-looking
		// credential and the relay would refuse every allocation in production
		// while everything looked fine here.
		const mine = await iceServers(600);
		const username = mine[1]?.username ?? '';
		expect(mine[1]?.credential).not.toBe(await expectedCredential('a-different-secret', username));
	});

	it('splits and trims a comma-separated list', async () => {
		env['TURN_URLS'] = 'turn:a.example:3478, turn:b.example:3478 ,turns:c.example:5349';
		const servers = await iceServers();
		expect(servers[1]?.urls).toEqual([
			'turn:a.example:3478',
			'turn:b.example:3478',
			'turns:c.example:5349'
		]);
	});

	it('never returns the shared secret itself', async () => {
		// AR-DEPLOY-6: this response goes to a browser. The secret stays server-side
		// and only its HMAC leaves.
		expect(JSON.stringify(await iceServers())).not.toContain('a-shared-secret');
	});
});
