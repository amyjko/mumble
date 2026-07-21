import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { canonicalRoomName, isValidRoomName } from '$lib/model/room-name';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import { roomBudgetResetsAt, roomHasTime } from '$lib/server/ledger';

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

	const db = supabaseAdmin();
	const room = await db.from('rooms').select('id').eq('name', name).maybeSingle();
	if (room.data === null) error(404, 'No such room');

	/*
	 * Whether the room asks before letting you in (UX-ID-3).
	 *
	 * Read HERE rather than in the browser, because a guest cannot read it for
	 * themselves: `room_state` requires admitted-ness, which is the very thing
	 * being decided. Without this the join prompt could not know whether to
	 * offer the hello field (UX-ID-2) — it would have to ask everyone for a
	 * message most rooms will never show anyone.
	 *
	 * Not a secret: it is the sign on the door, and the door is already visible
	 * to anyone holding the link.
	 */
	const settings = await db
		.from('room_state')
		.select('admission')
		.eq('room_id', room.data.id)
		.maybeSingle();

	/*
	 * Has this room used its week? (AR-COST-4, UX-ECON-2)
	 *
	 * The COURTEOUS half of the gate. The authoritative refusal is at the
	 * mutation route, where arrival actually happens; this exists so that the
	 * refusal arrives as a sentence a person can act on instead of a canvas
	 * that silently declines to accept them.
	 *
	 * Read here for the same reason `admission` is: the visitor cannot read it
	 * for themselves. The budget belongs to the room's OWNER, and `accounts` is
	 * readable only by its own holder — which is exactly right, and exactly why
	 * a guest standing at the door needs the server to answer for them.
	 *
	 * Not a secret either: it says nothing about the owner's account beyond the
	 * fact this room is closed until a date, which is what the person at the
	 * door has to be told.
	 */
	const outOfTime = !(await roomHasTime(db, room.data.id));

	return {
		roomId: room.data.id,
		asksAdmission: settings.data?.admission === 'ask',
		outOfTime,
		budgetResetsAt: outOfTime ? await roomBudgetResetsAt(db, room.data.id) : null
	};
};
