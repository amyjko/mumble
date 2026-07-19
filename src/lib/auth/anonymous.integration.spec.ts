import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY } from '$env/static/public';
import { claimsSchema } from '$lib/model/schemas';

/**
 * AR-TEST-7: prove Auth actually emits `is_anonymous`.
 *
 * The pgTAP matrix asserts our ASSUMPTION about the claim — the vendored helper
 * writes `is_anonymous` into the claims blob by hand, so every RLS test there
 * would pass identically if Supabase stopped emitting it tomorrow. Only a real
 * sign-in proves the assumption holds, and this seam — between what we believe
 * the token contains and what it contains — is exactly where a silent failure
 * of the whole anonymous permission model would live.
 *
 * Runs against the local stack, hence `integration`: `pnpm test:unit` stays
 * offline and fast.
 */

// The same env the app reads, so a key mismatch between test and runtime is
// impossible rather than merely unlikely.
const url = PUBLIC_SUPABASE_URL;
const key = PUBLIC_SUPABASE_PUBLISHABLE_KEY;

function decodeClaims(accessToken: string): Record<string, unknown> {
	const payload = accessToken.split('.')[1] ?? '';
	// Decoding, NOT verifying — the point is to read what the issuer emitted.
	// Verification is the server's job and hooks.server.ts does it properly.
	const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
	const parsed: unknown = JSON.parse(json);
	return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {};
}

describe('a real anonymous sign-in', () => {
	it('emits is_anonymous: true, which every RLS policy depends on', async () => {
		const supabase = createClient(url, key);
		const { data, error } = await supabase.auth.signInAnonymously();

		expect(error, 'anonymous sign-in must be enabled in config.toml').toBeNull();
		expect(data.session).not.toBeNull();
		const token = data.session?.access_token ?? '';

		const raw = decodeClaims(token);
		expect(raw['is_anonymous'], 'the claim exists AT ALL').toBeDefined();
		expect(raw['is_anonymous']).toBe(true);

		// And it survives our own parsing boundary, which is what the app reads.
		const claims = claimsSchema.parse(raw);
		expect(claims.is_anonymous).toBe(true);
		expect(claims.sub).toMatch(/^[0-9a-f-]{36}$/);

		await supabase.auth.signOut();
	});

	it('gives anonymous users the AUTHENTICATED role, not `anon`', async () => {
		// The trap that would quietly void every anonymous test: `anon` is an
		// UNAUTHENTICATED request; an anonymous user is authenticated, just with
		// is_anonymous true. Unrelated concepts sharing a word.
		const supabase = createClient(url, key);
		const { data } = await supabase.auth.signInAnonymously();
		const raw = decodeClaims(data.session?.access_token ?? '');

		expect(raw['role']).toBe('authenticated');
		await supabase.auth.signOut();
	});

	it('refuses to create a room, through the real RLS policy', async () => {
		// The end-to-end version of the pgTAP assertion: a REAL anonymous token
		// hitting the REAL policy, rather than a hand-written claims blob.
		const supabase = createClient(url, key);
		const { data } = await supabase.auth.signInAnonymously();
		const uid = data.session?.user.id ?? '';

		const { error } = await supabase.from('rooms').insert({ name: 'anonroom', owner_id: uid });
		expect(error, 'anonymous room creation must be refused').not.toBeNull();
		// 42501 is insufficient_privilege — the RLS denial.
		expect(error?.code).toBe('42501');

		await supabase.auth.signOut();
	});
});
