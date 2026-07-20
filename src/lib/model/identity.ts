import { parseJson, storedIdentitySchema } from './schemas';
import type { StoredIdentity } from './types';

const KEY = 'mumble:identity';
/**
 * Camera-off faces a participant can pick (UX-AV-3). Glyph data lives in a
 * module so every render goes through <Emoji> and therefore --font-emoji
 * (no-raw-emoji.spec.ts enforces this).
 */
export const AVATAR_EMOJI = ['🦊', '🐙', '🦎', '🐸', '🦜', '🐢', '🦔', '🐳', '🦩', '🐝', '🦋', '🐬'];

/**
 * Faces for dev-panel fake participants. Glyph data belongs in a module, not
 * in component markup — that is what lets no-raw-emoji.spec.ts guarantee every
 * emoji renders through <Emoji> and therefore through --font-emoji.
 */
export const FAKE_EMOJI = ['🐨', '🦉', '🐰', '🦁', '🐷'];
export const FAKE_EMOJI_FALLBACK = '🐨';

/**
 * Per-browser identity (the stub's echo of UX-ID-5: stable in this browser,
 * lost with its storage — the same boundary AR-AUTH-6 documents). Replaced by
 * Supabase anonymous auth when the real store lands; the id remains a UUID so
 * nothing downstream changes shape.
 */
/**
 * The identity stored in this browser, or null on a first visit.
 *
 * Returning null rather than inventing one is the point: UX-ID-1 says joining
 * may be anonymous but **a name is required**, and a generated `guest-473` is
 * not a name anyone chose. The caller asks before joining.
 */
export function loadIdentity(): StoredIdentity | null {
	const raw = localStorage.getItem(KEY);
	if (raw === null) return null;
	const parsed = storedIdentitySchema.safeParse(parseJson(raw));
	return parsed.success ? parsed.data : null;
}

/** A suggested face for the join prompt, so the picker starts somewhere. */
export function suggestedEmoji(): string {
	return AVATAR_EMOJI[Math.floor(Math.random() * AVATAR_EMOJI.length)] ?? '🐙';
}

/**
 * Mint an identity for a name the participant actually chose.
 *
 * Deliberately does NOT persist it. The id here is a placeholder: the real one
 * is the authenticated user id, which the join RPC returns a moment later, and
 * this function has no way to know it. Persisting the placeholder left
 * localStorage holding an id that matches nothing — not the participant row,
 * not the membership row, not the actor the server enforces against.
 *
 * That was harmless in practice, and only because of an ordering accident: the
 * canvas cannot mount until the store has read the room, which cannot happen
 * until the actor is known, by which point the caller has already replaced this
 * id. Relying on that is a trap for the next person who mounts something
 * earlier. The caller persists once the id is authoritative.
 */
export function createIdentity(name: string, emoji: string): StoredIdentity {
	return { id: crypto.randomUUID(), name: name.trim(), emoji };
}

export function saveIdentity(identity: StoredIdentity): void {
	localStorage.setItem(KEY, JSON.stringify(identity));
}
