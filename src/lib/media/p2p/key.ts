import { z } from 'zod';
import { GRANT_ALGORITHM } from '$lib/media/grant';

/**
 * The grant-verifying public key, fetched once (AR-MEDIA-2).
 *
 * Cached as a PROMISE rather than a value, so twenty peers arriving at once
 * produce one request rather than twenty — and so a caller that needs it before
 * it has landed waits rather than deciding without it.
 *
 * Public by definition: it verifies grants and cannot mint them, which is the
 * whole reason the scheme is asymmetric. Fetching it needs no authentication and
 * leaks nothing.
 */

let cached: Promise<CryptoKey> | null = null;

export function mediaPublicKey(): Promise<CryptoKey> {
	cached ??= load();
	return cached;
}

/*
 * A public EC key, and only the public half.
 *
 * `d` is the private component and is deliberately NOT in this schema: it is
 * stripped server-side, and a route that ever leaked one should not have its
 * mistake quietly imported here as a usable signing key.
 *
 * Fields are assembled explicitly rather than spread, because
 * `exactOptionalPropertyTypes` rejects spreading a possibly-undefined value into
 * an optional property.
 */
const z_publicJwk = z.object({
	// Nested under `key`, as the route serves it. Parsing the response body as
	// the JWK itself failed on every load and was caught by room.e2e's
	// "zero uncaught errors" guard rather than by anything media-specific.
	key: z.object({
		kty: z.string(),
		crv: z.string(),
		x: z.string(),
		y: z.string()
	})
});

async function load(): Promise<CryptoKey> {
	const response = await fetch('/api/media/key');
	if (!response.ok) throw new Error('no media key');
	const parsed = z_publicJwk.safeParse(await response.json());
	if (!parsed.success) throw new Error('malformed media key');
	const jwk: JsonWebKey = {
		kty: parsed.data.key.kty,
		crv: parsed.data.key.crv,
		x: parsed.data.key.x,
		y: parsed.data.key.y
	};
	return crypto.subtle.importKey('jwk', jwk, GRANT_ALGORITHM, true, ['verify']);
}

/** Test seam: forget the cached key. */
export function forgetMediaKey(): void {
	cached = null;
}
