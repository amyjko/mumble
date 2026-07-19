import { claimsSchema } from '$lib/model/schemas';
import type { Claims } from '$lib/model/types';

/**
 * Parse a verified JWT's claims, or null.
 *
 * The boundary between "what we believe the token contains" and what it
 * contains — AR-TEST-7 calls this out as precisely where a silent failure of
 * the whole anonymous permission model would live. Parsing rather than casting
 * means a token missing `sub` is null here instead of `undefined` three layers
 * down, and it is why `claims.is_anonymous` is a boolean at every call site.
 */
export function parseClaims(raw: Record<string, unknown> | null): Claims | null {
	if (raw === null) return null;
	const parsed = claimsSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

/**
 * Whether these claims represent someone who may CREATE a room (AR-AUTH-7).
 *
 * Anonymous counts as unauthenticated HERE SPECIFICALLY and nowhere else: a
 * guest may join, edit, draw, and speak, but rooms belong to accounts
 * (UX-ID-4). The asymmetry is the whole of that requirement, so it gets a name
 * rather than being an inline `!claims.is_anonymous` that reads like a bug.
 */
export function mayCreateRoom(claims: Claims | null): boolean {
	return claims !== null && !claims.is_anonymous;
}
