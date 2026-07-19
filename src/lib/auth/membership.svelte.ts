import { supabaseBrowser, ensureSession } from './browser-client';

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
}

export async function joinRoom(name: string): Promise<Membership> {
	const userId = await ensureSession();
	if (userId === null) return { userId: null, roomId: null, isHost: false };

	const { data, error } = await supabaseBrowser().rpc('join_room', { p_name: name });
	// A failure here must not blank the canvas: the room still works on the
	// stub, you simply are not a host. Silence would be wrong; the console is
	// where a developer looks when host controls are missing.
	if (error !== null) {
		console.warn('mumble: could not join room', error.message);
		return { userId, roomId: null, isHost: false };
	}

	const row = data.at(0);
	if (row === undefined) return { userId, roomId: null, isHost: false };
	return { userId, roomId: row.out_room_id, isHost: row.out_is_host };
}
