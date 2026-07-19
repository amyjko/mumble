import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import type { StoredIdentity } from '$lib/model/types';

/**
 * Avatar identity that follows the person (UX-ID-6, UX-ID-9).
 *
 * Name and emoji are IDENTITY, not room state — "the same person on laptop and
 * phone is one identity". They lived only in localStorage, so signing in on a
 * second machine gave you your rooms and your objects and a blank stranger's
 * face.
 *
 * The reconciliation rule, and the reason it is this way round:
 *
 *   profile exists  → it wins. It is the roaming copy, and the browser you are
 *                     sitting at is the incidental thing.
 *   profile absent  → seed it from whatever this browser knows. That is how a
 *                     name someone already chose survives their first sign-in
 *                     instead of being silently replaced by a prompt.
 *
 * Nothing here branches on `is_anonymous`. An anonymous user has a real auth id
 * and gets a real profile; it simply does not roam, because the IDENTITY is
 * browser-bound (AR-AUTH-6). The boundary is a property of the account, not of
 * the storage, and encoding it here would define it twice.
 */
export interface Profile {
	name: string;
	emoji: string;
}

/** The stored profile for this identity, or null if they have none yet. */
export async function loadProfile(
	db: SupabaseClient<Database>,
	userId: string
): Promise<Profile | null> {
	const { data, error } = await db
		.from('profiles')
		.select('name, emoji')
		.eq('id', userId)
		.maybeSingle();
	if (error !== null || data === null) return null;
	return { name: data.name, emoji: data.emoji };
}

/** Write this identity's name and face. Idempotent; safe to call on every edit. */
export async function saveProfile(
	db: SupabaseClient<Database>,
	userId: string,
	profile: Profile
): Promise<void> {
	await db
		.from('profiles')
		.upsert({ id: userId, ...profile, updated_at: new Date().toISOString() });
}

/**
 * Reconcile the stored profile with what this browser knows.
 *
 * Returns the identity to use, and seeds the profile from local details when
 * there is nothing stored yet — the "pick up local details" half. A failed
 * write is not fatal: you keep the local identity for this session rather than
 * being blocked from a room over a network blip.
 */
export async function syncProfile(
	db: SupabaseClient<Database>,
	userId: string,
	local: StoredIdentity | null
): Promise<Profile | null> {
	const stored = await loadProfile(db, userId);
	if (stored !== null) return stored;
	if (local === null) return null;

	const seeded: Profile = { name: local.name, emoji: local.emoji };
	await saveProfile(db, userId, seeded);
	return seeded;
}

/**
 * Save the SIGNED-IN user's profile, resolving who that is internally.
 *
 * Deliberately takes no id. The obvious call site has an `identity.id` to hand
 * — and it is the wrong one: until the store swap, that is still the
 * localStorage UUID, not the auth user id. Passing it would fail the
 * `id = auth.uid()` policy and, because RLS refusals on INSERT are not thrown
 * back through the client the way a constraint would be, do so QUIETLY. A
 * profile that never saves and never complains is exactly the bug this whole
 * change is fixing.
 */
export async function saveMyProfile(
	db: SupabaseClient<Database>,
	profile: Profile
): Promise<void> {
	const { data } = await db.auth.getSession();
	const userId = data.session?.user.id;
	if (userId === undefined) return;
	await saveProfile(db, userId, profile);
}
