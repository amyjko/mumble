import { json, type RequestHandler } from '@sveltejs/kit';
import { mediaKey } from '$lib/server/media-key';

/**
 * The public half of the grant-signing key (AR-MEDIA-2).
 *
 * Peers fetch this once and verify every grant locally. That is the point of
 * signing asymmetrically: on P2P there is no server in the media path, so the
 * only party able to refuse an unauthorized offer is the peer receiving it, and
 * it cannot phone home for each one.
 *
 * Deliberately unauthenticated. It is a PUBLIC key — it verifies signatures and
 * cannot produce them, so nothing is protected by hiding it, and requiring a
 * session would only mean a peer cannot check an offer that arrives before its
 * own session settles.
 */
export const GET: RequestHandler = async () => {
	const { publicJwk } = await mediaKey();
	return json(
		{ key: publicJwk },
		{
			// Cacheable, but not for long: the key rotates when the secret does,
			// and a peer holding a stale one refuses every grant in the room.
			headers: { 'cache-control': 'public, max-age=300' }
		}
	);
};
