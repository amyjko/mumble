import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { canonicalRoomName, isValidRoomName } from '$lib/model/room-name';

/**
 * Client-rendered: the canvas is per-viewer state (UX-CANVAS-2) and the stub
 * store needs browser APIs (BroadcastChannel, localStorage). Nothing here is
 * SEO-relevant; the shell still serves from the worker.
 */
export const ssr = false;

/**
 * UX-ROOM-9's name rule, enforced at the route from day one — now from the one
 * shared module rather than a second copy of the pattern. A reserved name 404s
 * exactly like a malformed one: from outside, an unclaimable name and a
 * nonexistent room are the same thing.
 */
export const load: PageLoad = ({ params }) => {
	if (!isValidRoomName(params.room)) error(404, 'No such room');
	return { room: canonicalRoomName(params.room) };
};
