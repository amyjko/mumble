import { parseJson, storedIdentitySchema } from './schemas';
import type { StoredIdentity } from './types';

const KEY = 'mumble:identity';
const EMOJI = ['🦊', '🐙', '🦎', '🐸', '🦜', '🐢', '🦔', '🐳', '🦩', '🐝'];

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
export function getOrCreateIdentity(): StoredIdentity {
	const raw = localStorage.getItem(KEY);
	if (raw !== null) {
		const parsed = storedIdentitySchema.safeParse(parseJson(raw));
		if (parsed.success) return parsed.data;
	}
	const fresh: StoredIdentity = {
		id: crypto.randomUUID(),
		name: `guest-${String(Math.floor(Math.random() * 1000))}`,
		emoji: EMOJI[Math.floor(Math.random() * EMOJI.length)] ?? '🐙'
	};
	localStorage.setItem(KEY, JSON.stringify(fresh));
	return fresh;
}

export function saveIdentity(identity: StoredIdentity): void {
	localStorage.setItem(KEY, JSON.stringify(identity));
}
