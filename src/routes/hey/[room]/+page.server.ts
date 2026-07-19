import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { canonicalRoomName, isValidRoomName } from '$lib/model/room-name';
import { supabaseAdmin } from '$lib/server/supabase-admin';

/**
 * Does this room exist? (UX-ROOM-8)
 *
 * With the canvas on the stub, any URL was a room: the store invented one in
 * localStorage on arrival. Against Postgres a room has to have been CREATED,
 * and the browser needs its id — `save_room_state`/`get_room_state` are keyed
 * by uuid, while the URL carries the name.
 *
 * `export const ssr = false` in +page.ts does NOT stop this from running: that
 * flag disables server RENDERING, not server `load`. The trap is on the other
 * side — when both loads exist, the page receives the UNIVERSAL one's return
 * value, so +page.ts has to forward `roomId` explicitly or it silently vanishes.
 *
 * Read with the admin client on purpose. RLS hides a room from anyone who is
 * not yet a member, which is every first-time joiner following an invite link —
 * checking as the visitor would 404 exactly the people the link is for. Room
 * existence is not a secret; a room's CONTENTS are, and those are still gated.
 */
export const load: PageServerLoad = async ({ params }) => {
	if (!isValidRoomName(params.room)) error(404, 'No such room');
	const name = canonicalRoomName(params.room);

	const room = await supabaseAdmin().from('rooms').select('id').eq('name', name).maybeSingle();
	if (room.data === null) error(404, 'No such room');

	return { roomId: room.data.id };
};
