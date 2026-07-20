import { env } from '$env/dynamic/private';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { GRANT_ALGORITHM } from '$lib/media/grant';

/**
 * The key that signs publish grants (AR-MEDIA-2, AR-DEPLOY-6).
 *
 * A stored secret, read at RUNTIME from the platform's store so a build
 * artifact never contains it — the same reasoning as `supabase-admin.ts`.
 * `MEDIA_SIGNING_KEY` is a base64 private JWK; the public half is served from
 * `/api/media/key` so every peer can verify locally without a round trip.
 *
 * ## Why generating one is a production hazard, and refused
 *
 * Workers run many isolates. A key generated at cold start differs per isolate,
 * so a grant signed by one and verified against another's public key fails —
 * intermittently, in proportion to traffic, presenting as "video sometimes
 * doesn't connect". That is a miserable bug to chase, so this refuses to
 * generate when it looks like production.
 *
 * Locally it DOES generate, because a dev stack has one isolate and asking
 * every contributor to mint a key before the app runs is friction with no
 * safety payoff. The test is where Supabase points: a stack on localhost is a
 * dev stack. Production points somewhere else and gets a loud failure at first
 * use rather than a silent per-isolate key.
 */

let cached: { signing: CryptoKey; publicJwk: JsonWebKey } | null = null;

function looksLocal(): boolean {
	return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(PUBLIC_SUPABASE_URL);
}

/**
 * The public half, minus the private scalar. Safe to hand to anyone.
 *
 * Built by DELETING the private fields rather than by listing the public ones:
 * a copy that enumerates what to keep silently drops anything a future curve
 * adds, and the failure would be a key that verifies nothing. Under
 * `exactOptionalPropertyTypes` this also avoids writing `undefined` into
 * optional fields, which is not the same as omitting them.
 */
function publicPartOf(jwk: JsonWebKey): JsonWebKey {
	const { d, ...rest } = jwk;
	void d;
	return { ...rest, key_ops: ['verify'], ext: true };
}

async function load(): Promise<{ signing: CryptoKey; publicJwk: JsonWebKey }> {
	/*
	 * Read as `unknown`, deliberately.
	 *
	 * `$env/dynamic/private`'s types are generated from whatever `.env` held at
	 * build time, so a variable merely LISTED there types as always-present —
	 * and the presence check becomes "unnecessary" to the linter. That is a
	 * statement about a file, not about the running platform: in production this
	 * comes from a secret store that may not have it. CI found this exact
	 * disagreement, because it copies `.env.example` and I do not.
	 */
	const raw: unknown = env['MEDIA_SIGNING_KEY'];
	const encoded = typeof raw === 'string' ? raw.trim() : '';

	if (encoded !== '') {
		const parsed: unknown = JSON.parse(atob(encoded));
		if (typeof parsed !== 'object' || parsed === null) {
			throw new Error('MEDIA_SIGNING_KEY is not a JWK');
		}
		// Structural, not asserted: this is a secret coming from outside, and
		// `as` is banned here for exactly that kind of value.
		const jwk: JsonWebKey = parsed;
		const signing = await crypto.subtle.importKey('jwk', jwk, GRANT_ALGORITHM, false, ['sign']);
		return { signing, publicJwk: publicPartOf(jwk) };
	}

	if (!looksLocal()) {
		// Loud, and at first use rather than at deploy: a silent per-isolate key
		// would work in testing and fail under load.
		throw new Error(
			'MEDIA_SIGNING_KEY is not set. Generating one per isolate would make grant verification fail intermittently in production.'
		);
	}

	/*
	 * A FIXED local key, not a generated one — and the difference is the whole
	 * point of this branch.
	 *
	 * Generating one per isolate was the original behaviour, and its comment
	 * warned that grants "will not verify across a restart". That understated
	 * it: the worker runs the key route and the session route in DIFFERENT
	 * isolates, so a browser could fetch one public key and be handed a grant
	 * signed by another, within a single page load. Every peer then refused
	 * every offer with a signature failure — which looks exactly like a
	 * networking problem and is not one. It cost an evening to find, from a
	 * symptom two layers away.
	 *
	 * This key is PUBLIC KNOWLEDGE and deliberately so. It is committed, it is
	 * in the repository, and it authorizes nothing beyond publishing into a
	 * local room: `looksLocal()` above refuses to reach this line against any
	 * non-local Supabase, and a deployment without MEDIA_SIGNING_KEY throws
	 * rather than falling back here. Treating it as a secret would be a
	 * misunderstanding — it exists so that a development stack is DETERMINISTIC,
	 * the same reason the local Supabase ships well-known demo keys.
	 */
	const DEVELOPMENT_ONLY_KEY: JsonWebKey = {
		kty: 'EC',
		crv: 'P-256',
		x: '1EmDobFC656X-9voSgKgp-VsYk3t2V_NlgCCcqw98yA',
		y: 'gEgmhuifxnM5XwYkIJTIx0Y69umUNRo2ueIZktot5DE',
		d: 'xKHuGJ2rc-beerfMU1MpPhxV2SfTeqboAAzIRqFW8Y4'
	};
	const signing = await crypto.subtle.importKey('jwk', DEVELOPMENT_ONLY_KEY, GRANT_ALGORITHM, false, [
		'sign'
	]);
	return { signing, publicJwk: publicPartOf(DEVELOPMENT_ONLY_KEY) };
}

/** Memoized per isolate — importing a key on every request is pure overhead. */
export async function mediaKey(): Promise<{ signing: CryptoKey; publicJwk: JsonWebKey }> {
	cached ??= await load();
	return cached;
}
