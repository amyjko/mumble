import { redirect, type RequestHandler } from '@sveltejs/kit';

/**
 * POST only, never GET.
 *
 * A GET sign-out is CSRF-able — any page that can make you load an image can
 * sign you out — and browsers prefetch links, so it also signs people out by
 * accident. The form that posts here is the whole UI.
 */
export const POST: RequestHandler = async ({ locals }) => {
	await locals.supabase.auth.signOut();
	redirect(303, '/');
};
