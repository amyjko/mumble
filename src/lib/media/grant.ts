import { z } from 'zod';

/**
 * The publish capability (AR-MEDIA-2, UX-STAGE-6). Pure and node-tested.
 *
 * A short-lived, signed statement from the control plane saying "this peer, in
 * this room, may publish these kinds, as of this stage version". Peers verify
 * it locally with a public key, which is the whole reason it is signed rather
 * than merely returned: on P2P there is no server in the media path, so the
 * only party in a position to refuse an unauthorized offer is the peer
 * receiving it, and a peer cannot phone home for every offer.
 *
 * ## Why a signature is load-bearing, and not ceremony
 *
 * Realtime's `room_channel_write` policy proves a sender is IN the room. It
 * proves nothing about who they claim to be — the `from` field of a broadcast
 * is chosen by whoever sends it. So an admitted member could offer media while
 * claiming to be the slot holder, and a receiver checking only the holder list
 * would believe them. The grant is what makes "peer P is really P" true; the
 * holder list is what makes the authorization CURRENT. Neither is sufficient
 * alone, which is why the transport checks both.
 *
 * ## The honest limit
 *
 * This is enforced by the receiving peers, because on P2P nothing else is in a
 * position to. A room in which EVERY client is patched can carry media the
 * stage never authorized. That is structural to P2P rather than a defect here,
 * and it is recorded against AR-MEDIA-2, UX-STAGE-6 and AR-TEST-10 instead of
 * being quietly under-delivered.
 *
 * ECDSA P-256 over WebCrypto: available unchanged in workerd, the browser and
 * node, and asymmetric so a verifier never holds anything that could mint one.
 */

export const grantBodySchema = z.object({
	/** The room this is good for. A grant from another room is not a grant. */
	room: z.uuid(),
	/** The participant authorized to publish — the actor id, not a tab. */
	peer: z.uuid(),
	publish: z.object({ video: z.boolean(), audio: z.boolean() }),
	/**
	 * `rooms.version` at issue. Binds the grant to a moment in the stage's
	 * history, so one minted before a revoke cannot be replayed after it.
	 */
	stage: z.number(),
	/** Seconds since the epoch, both. */
	iat: z.number(),
	exp: z.number()
});

export type GrantBody = z.infer<typeof grantBodySchema>;

/** Both halves base64url, so a grant survives a JSON round trip untouched. */
export const grantSchema = z.object({ body: z.string(), sig: z.string() });
export type Grant = z.infer<typeof grantSchema>;

export const GRANT_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' } as const;

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
	// Rejected rather than coerced: this parses attacker-supplied input, and
	// `atob` throws on malformed data.
	if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
	const padded = value.replace(/-/g, '+').replace(/_/g, '/');
	try {
		const binary = atob(padded);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

export async function signGrant(body: GrantBody, key: CryptoKey): Promise<Grant> {
	const encoded = new TextEncoder().encode(JSON.stringify(body));
	const signature = await crypto.subtle.sign(SIGN_PARAMS, key, encoded);
	return { body: toBase64Url(encoded), sig: toBase64Url(new Uint8Array(signature)) };
}

/**
 * The body, or NULL for any reason at all.
 *
 * One return type for every failure — bad base64, bad JSON, wrong shape, bad
 * signature, expired — because a caller must treat them identically. A
 * verifier that distinguished "malformed" from "forged" would invite a call
 * site that handles one and not the other.
 */
export async function verifyGrant(
	grant: Grant,
	key: CryptoKey,
	nowSeconds: number
): Promise<GrantBody | null> {
	const bodyBytes = fromBase64Url(grant.body);
	const sigBytes = fromBase64Url(grant.sig);
	if (bodyBytes === null || sigBytes === null) return null;

	// Signature FIRST, before the bytes are interpreted: parsing unverified
	// input is the step worth doing as little of as possible.
	const ok = await crypto.subtle.verify(SIGN_PARAMS, key, sigBytes, bodyBytes);
	if (!ok) return null;

	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(new TextDecoder().decode(bodyBytes));
	} catch {
		return null;
	}

	const parsed = grantBodySchema.safeParse(parsedJson);
	if (!parsed.success) return null;
	if (parsed.data.exp <= nowSeconds) return null;
	return parsed.data;
}

/**
 * Whether a verified grant authorizes THIS offer.
 *
 * Separate from `verifyGrant` on purpose: verification says the control plane
 * issued it, and this says it is the right one for what is being attempted. A
 * valid grant for another room, another peer, or audio-when-video-was-offered
 * is a real thing an attacker can hold, and each is a different mistake to
 * make.
 */
export function grantAllows(
	body: GrantBody,
	claim: { room: string; peer: string; kind: 'video' | 'audio' }
): boolean {
	if (body.room !== claim.room) return false;
	if (body.peer !== claim.peer) return false;
	return claim.kind === 'video' ? body.publish.video : body.publish.audio;
}
