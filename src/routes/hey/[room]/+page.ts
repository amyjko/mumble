import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * Client-rendered: the canvas is per-viewer state (UX-CANVAS-2) and the stub
 * store needs browser APIs (BroadcastChannel, localStorage). Nothing here is
 * SEO-relevant; the shell still serves from the worker.
 */
export const ssr = false;

/** UX-ROOM-9's name rule, enforced at the route from day one. */
const ROOM_NAME = /^[a-z0-9_-]{2,32}$/i;

export const load: PageLoad = ({ params }) => {
	if (!ROOM_NAME.test(params.room)) error(404, 'No such room');
	return { room: params.room.toLowerCase() };
};
