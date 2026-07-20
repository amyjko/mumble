import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import AvatarTile from './AvatarTile.svelte';
import { MemoryRoomStore } from '$lib/store/memory-store.svelte';
import { SyncClient } from '$lib/store/sync-client.svelte';
import { Viewport } from './viewport.svelte';
import { newParticipant } from '$lib/model/avatar';

/**
 * The blocked-camera badge (UX-AV-3).
 *
 * Someone whose browser refuses the camera holds a slot and shows nothing, which
 * looks like the room is broken rather than like a permission they withheld.
 * `Capture` computed that state from the beginning and nothing rendered it.
 *
 * Rendered here rather than asserted through the session, because the two rules
 * that matter are about WHO SEES IT, and both live in the markup.
 */

const ME = '11111111-1111-4111-8111-111111111111';
const THEM = '22222222-2222-4222-8222-222222222222';

function mount(options: {
	id: string;
	isSelf: boolean;
	cameraDenied: boolean;
	holdsVideo: boolean;
	holdsAudio?: boolean;
}): void {
	const store = new MemoryRoomStore(`tile-${crypto.randomUUID()}`, ME);
	const participant = newParticipant({ id: options.id, name: 'Someone', emoji: '🦊' });
	store.state.participants[options.id] = participant;
	if (options.holdsVideo) store.state.video_holders = [options.id];
	if (options.holdsAudio === true) store.state.audio_holders = [options.id];

	// `render` resolves when mounted; the assertions below use `expect.element`,
	// which retries, so awaiting it here would add nothing.
	void render(AvatarTile, {
		participant,
		store,
		sync: new SyncClient(store),
		viewport: new Viewport(),
		obstacles: () => [],
		isSelf: options.isSelf,
		cameraDenied: options.cameraDenied
	});
}

// `Emoji` renders role="img" with an aria-label when the glyph itself carries
// the information, so this asserts what a screen reader would announce.
const badge = () => page.getByRole('img', { name: 'your browser is blocking the camera' });

describe('when the browser refuses your camera', () => {
	it('says so on your own tile', async () => {
		mount({ id: ME, isSelf: true, cameraDenied: true, holdsVideo: true });
		await expect.element(badge()).toBeVisible();
	});

	it('says nothing when the camera was simply not asked for', async () => {
		// Holding no slot means not trying to be seen. Shouting about a
		// permission nobody needed yet would be noise.
		mount({ id: ME, isSelf: true, cameraDenied: true, holdsVideo: false });
		await expect.element(badge()).not.toBeInTheDocument();
	});

	it('says nothing to someone holding only an AUDIO slot', async () => {
		/*
		 * The case that makes the slot check load-bearing, and it was missing:
		 * with no slots at all the enclosing badge group is absent anyway, so a
		 * test using that state passes whether or not the check exists. Mutation
		 * testing caught it — removing the check failed nothing.
		 *
		 * Someone on a microphone never asked for a camera, so telling them one
		 * is blocked is a complaint about a thing they were not attempting.
		 */
		mount({ id: ME, isSelf: true, cameraDenied: true, holdsVideo: false, holdsAudio: true });
		await expect.element(badge()).not.toBeInTheDocument();
	});

	it('says nothing when nothing was refused', async () => {
		mount({ id: ME, isSelf: true, cameraDenied: false, holdsVideo: true });
		await expect.element(badge()).not.toBeInTheDocument();
	});

	it('never tells the ROOM about somebody else’s permission', async () => {
		/*
		 * The privacy half, and the reason this is a component test.
		 *
		 * A peer looking at a blank tile learns nothing actionable from knowing
		 * why it is blank, and whether a person granted a browser permission is
		 * theirs to disclose. `cameraDenied` describes THIS browser, so rendering
		 * it on anyone else's tile would also simply be wrong.
		 */
		mount({ id: THEM, isSelf: false, cameraDenied: true, holdsVideo: true });
		await expect.element(badge()).not.toBeInTheDocument();
	});
});
