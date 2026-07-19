import { supabaseBrowser, ensureSession } from './browser-client';
import { syncProfile, type Profile } from './profile';
import type { StoredIdentity } from '$lib/model/types';

/**
 * Who you are in THIS room (AR-CTRL-7, UX-PERM-3).
 *
 * `isHost` finally has a source. Until now it was the literal `false` at every
 * call site, with a comment promising it would light up "when the role
 * arrives"; it arrives here, from a membership row the client cannot write.
 *
 * A room absent from Postgres yields `roomId: null` and no host. That is the
 * TRANSITIONAL state: canvas content still lives in the browser stub, so a
 * room can be visited without having been created. Phase 5 removes it, and
 * with it this whole nullable case.
 */
export interface Membership {
	userId: string | null;
	roomId: string | null;
	isHost: boolean;
	/**
	 * The roaming avatar identity (UX-ID-6). Null when there is nothing stored
	 * and nothing local to seed it from — a genuine first visit, where the join
	 * prompt asks.
	 */
	profile: Profile | null;
	/**
	 * Whether the door let you in (UX-ID-3).
	 *
	 * 'admitted' is the common case and what every open room yields. 'pending'
	 * means a host has to decide; the room's own RLS already refuses a pending
	 * guest every state table, so the canvas cannot be rendered for them and the
	 * page shows the waiting room instead. 'declined' is final — rejoining
	 * cannot clear it.
	 */
	status: 'pending' | 'admitted' | 'declined';
}

export async function joinRoom(
	name: string,
	local: StoredIdentity | null = null,
	/** UX-ID-2's join message, shown to the host beside the name. */
	hello: string | null = null
): Promise<Membership> {
	const userId = await ensureSession();
	if (userId === null)
		return { userId: null, roomId: null, isHost: false, profile: null, status: 'admitted' };

	// Identity first: the name and face follow the person, so they are resolved
	// before anything room-shaped. Seeds from `local` when nothing is stored.
	const profile = await syncProfile(supabaseBrowser(), userId, local);

	const { data, error } = await supabaseBrowser().rpc('join_room', {
		p_name: name,
		...(hello === null || hello.trim() === '' ? {} : { p_hello: hello.trim() })
	});
	// A failure here must not blank the canvas: the room still works on the
	// stub, you simply are not a host. Silence would be wrong; the console is
	// where a developer looks when host controls are missing.
	if (error !== null) {
		console.warn('mumble: could not join room', error.message);
		return { userId, roomId: null, isHost: false, profile, status: 'admitted' };
	}

	const row = data.at(0);
	if (row === undefined)
		return { userId, roomId: null, isHost: false, profile, status: 'admitted' };
	const status =
		row.out_status === 'pending' || row.out_status === 'declined' ? row.out_status : 'admitted';
	return { userId, roomId: row.out_room_id, isHost: row.out_is_host, profile, status };
}
