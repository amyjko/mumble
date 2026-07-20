import { json, error, type RequestHandler } from '@sveltejs/kit';
import { parseClaims } from '$lib/auth/claims';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import { canonicalRoomName } from '$lib/model/room-name';
import { loadRoomState } from '$lib/server/room-state';
import { canPublishAudio, canPublishVideo } from '$lib/model/stage';
import { stage } from '$lib/model/rules';
import { mediaKey } from '$lib/server/media-key';
import { iceServers } from '$lib/server/ice';
import { signGrant, type GrantBody } from '$lib/media/grant';

/**
 * The publish gate (AR-MEDIA-2, AR-CTRL-1, UX-STAGE-6).
 *
 * Replaces a 19-line stub that returned `{ ok: true }` and enforced nothing.
 * A client asks here before it may send media, and gets two things: the ICE
 * servers to connect with, and a signed grant saying what it may publish.
 *
 * Authorization is NOT decided here. `model/stage.ts` already owns it —
 * `canPublishVideo` / `canPublishAudio`, the same pure predicates the rule
 * engine uses for `take_slot` — and this route is their transport. A second
 * copy of "who may publish" is how a gate and a canvas come to disagree.
 *
 * The preamble mirrors `mutate/+server.ts` exactly, because the properties are
 * the same: the actor comes from the VERIFIED JWT and never the body, and
 * membership is read server-side from the row RLS consults, so a request cannot
 * assert who it is or what role it holds.
 */

/**
 * Two minutes. Long enough to survive a slow build plus a slow suite, short
 * enough that a grant outlives a revoked slot only briefly — the holder list is
 * what makes authorization current, and the transport re-checks it per offer.
 */
const GRANT_TTL_SECONDS = 120;

export const POST: RequestHandler = async ({ params, locals }) => {
	const claims = parseClaims(await locals.safeGetClaims());
	if (claims === null) error(401, 'Not signed in');

	const db = supabaseAdmin();
	const name = canonicalRoomName(params.room ?? '');
	const room = await db.from('rooms').select('id').eq('name', name).maybeSingle();
	if (room.data === null) error(404, 'No such room');

	const membership = await db
		.from('room_members')
		.select('status')
		.eq('room_id', room.data.id)
		.eq('identity_id', claims.sub)
		.maybeSingle();
	if (membership.data === null || membership.data.status !== 'admitted') {
		error(403, 'Not a member of this room');
	}

	const room_state = await loadRoomState(db, room.data.id);
	if (room_state === null) error(404, 'No such room');

	/*
	 * The >=2-present rule (AR-CTRL-3, UX-ROOM-1): "no media session is
	 * established for a lone occupant".
	 *
	 * Enforced here as well as in `planMedia`, and deliberately: the client half
	 * exists so a lone occupant is never even prompted for a camera, and this
	 * half exists so the rule is a fact rather than a courtesy. Counted from
	 * participants, which presence now keeps honest — a crashed tab used to
	 * leave a row that satisfied this forever.
	 */
	const present = Object.keys(room_state.state.participants).length;
	if (present < 2) error(409, 'Nobody else is here yet');

	const publish = {
		video: canPublishVideo(stage(room_state.state), claims.sub),
		audio: canPublishAudio(stage(room_state.state), claims.sub, false)
	};

	/*
	 * A grant that permits nothing is refused outright rather than issued empty.
	 *
	 * A client holding no slot has no business opening a peer connection at all,
	 * and handing it a signed statement of its own powerlessness would invite a
	 * caller to treat "I have a grant" as "I may publish".
	 */
	if (!publish.video && !publish.audio) error(403, 'You hold no slot in this room');

	const issued = Math.floor(Date.now() / 1000);
	const body: GrantBody = {
		room: room.data.id,
		peer: claims.sub,
		publish,
		// `rooms.version` at issue: binds this to a moment in the stage's
		// history, so a grant minted before a revoke cannot be replayed after.
		stage: room_state.version,
		iat: issued,
		exp: issued + GRANT_TTL_SECONDS
	};

	const { signing } = await mediaKey();
	const grant = await signGrant(body, signing);

	return json({ grant, iceServers: await iceServers() });
};
