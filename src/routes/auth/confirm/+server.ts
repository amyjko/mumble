import { redirect, type RequestHandler } from '@sveltejs/kit';
import { confirmDestination } from './confirm';

/**
 * The magic-link landing (AR-AUTH-4, AR-TEST-8).
 *
 * Wiring only. Which link shapes are accepted, what a failure does, and why the
 * `next` guard is shaped the way it is all live in `confirm.ts`, where they can
 * be tested without a Supabase client — see that file for the two shapes and
 * the bug that hid in the gap between them.
 *
 * The SERVER client matters: exchanging a PKCE code needs the verifier cookie
 * `signInWithOtp` set on this browser, which only `locals.supabase` can read.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	redirect(303, await confirmDestination(url, locals.supabase.auth));
};
