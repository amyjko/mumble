import { env } from '$env/dynamic/private';

/**
 * ICE servers for a peer connection (AR-TRANSPORT-8, UX-QOS-6).
 *
 * STUN discovers a peer's public address; TURN relays when the network refuses
 * a direct path, which AR-TRANSPORT-8 puts at ~10-15% of connections. With a
 * P2P MVP the relay is the ONLY media spend the product carries, which is why
 * AR-COST-9 calls the relay fraction the single number worth watching early.
 *
 * The shape returned is `RTCIceServer`, a W3C type rather than a vendor one, so
 * this stays inside AR-TRANSPORT-10's rule: nothing above the transport adapter
 * learns which provider issued the credentials, and swapping coturn for a
 * hosted TURN changes this file alone.
 *
 * Credentials are minted SERVER-side and short-lived. They never appear in the
 * repo (AR-DEPLOY-6) and never reach a client that has not been authorized —
 * the same route that issues a grant issues these.
 */

export interface IceServer {
	urls: string | string[];
	username?: string;
	credential?: string;
}

/** Public STUN. No credentials, no cost, and useless for the relay tail. */
const STUN_ONLY: IceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/**
 * coturn's REST scheme: the username is an expiry, the credential is an HMAC of
 * it under a shared secret. The secret never leaves the server; the client gets
 * a pair that stops working shortly.
 */
async function coturnCredentials(secret: string, urls: string[], ttlSeconds: number): Promise<IceServer[]> {
	const username = String(Math.floor(Date.now() / 1000) + ttlSeconds);
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign']
	);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
	const bytes = new Uint8Array(mac);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return [{ urls, username, credential: btoa(binary) }];
}

/**
 * What a client should hand its peer connection.
 *
 * With no TURN configured this returns STUN only — which is honest rather than
 * degraded: locally there IS no relay, two browsers on one machine connect
 * host-candidate to host-candidate, and the relay path therefore has ZERO local
 * coverage. AR-TEST-10 lists that as a prod-only truth, and this is the code
 * that makes it one.
 */
export async function iceServers(ttlSeconds = 600): Promise<IceServer[]> {
	// `unknown` for the same reason as media-key.ts: the generated types describe
	// a build-time .env, not the platform's secret store at runtime.
	const rawSecret: unknown = env['TURN_SHARED_SECRET'];
	const rawUrls: unknown = env['TURN_URLS'];
	const secret = typeof rawSecret === 'string' ? rawSecret.trim() : '';
	const urls = typeof rawUrls === 'string' ? rawUrls.trim() : '';
	if (secret === '' || urls === '') {
		return STUN_ONLY;
	}
	const relay = await coturnCredentials(
		secret,
		urls.split(',').map((url) => url.trim()),
		ttlSeconds
	);
	// STUN first: a direct path is always preferred, and the relay is the
	// fallback that costs money.
	return [...STUN_ONLY, ...relay];
}
