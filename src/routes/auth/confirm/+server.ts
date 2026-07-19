import { redirect, type RequestHandler } from '@sveltejs/kit';
import { emailOtpTypeSchema } from '$lib/model/schemas';

/**
 * The magic-link landing (AR-AUTH-4, AR-TEST-8).
 *
 * `verifyOtp` with a token hash, not `exchangeCodeForSession` — this is the
 * email path, and it is the one AR-TEST-8 exercises offline by generating the
 * link server-side rather than scraping an inbox.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	const tokenHash = url.searchParams.get('token_hash');
	const type = emailOtpTypeSchema.safeParse(url.searchParams.get('type'));
	const next = url.searchParams.get('next');
	const destination = next !== null && next.startsWith('/') && !next.startsWith('//') ? next : '/';

	if (tokenHash === null || !type.success) {
		redirect(303, '/login?error=link');
	}

	const { error } = await locals.supabase.auth.verifyOtp({ token_hash: tokenHash, type: type.data });
	// A used, expired, or forged link all land here, and they are told apart
	// only by a message we would be guessing at. One honest failure.
	if (error) redirect(303, '/login?error=link');

	redirect(303, destination);
};
