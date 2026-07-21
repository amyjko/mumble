import { expect, test } from '@playwright/test';
import { joinRoom, roomName, settled } from './support/join';
import { hostRoom } from './support/auth';

/**
 * Turning one person down, for yourself only (UX-OBJ-16 × UX-AUDIO).
 *
 * DESIGN.md's open item: a screen share's sound had a per-viewer mute and a
 * person's voice had nothing — remote voices were a bare `<audio autoplay>` at
 * unity gain, with the autoplay-refusal path unhandled and untested.
 *
 * The component tests cover the control's contract in isolation. What only this
 * layer can prove is that the control reaches a REAL remote stream: that the
 * element playing a peer's voice is the one the slider moves, across two
 * browser contexts and an actual peer connection.
 */

test('a listener can turn one person down without anyone else knowing (UX-OBJ-16)', async ({
	browser
}) => {
	const room = roomName('voice');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	await hostRoom(host, room);
	await settled(host);
	await joinRoom(guest, room, 'Talker');
	await settled(guest);

	await expect(host.locator('html')).toHaveAttribute('data-media-peers', '1', { timeout: 60_000 });

	// The guest takes an audio slot and unmutes, so there is a voice to turn
	// down. Until somebody is audible there is deliberately no control at all —
	// a slider per silent avatar would be a wall of them.
	await guest.getByRole('button', { name: 'Unmute' }).click();
	await settled(guest);

	// The control appears on the SPEAKER's avatar in the listener's view, which
	// is the resolution to "a voice has no position": the person has one.
	const mute = host.getByRole('button', { name: 'Mute Talker for yourself' });
	await expect(mute).toBeVisible({ timeout: 15_000 });

	// The audio element carrying that voice is at full volume to begin with.
	const volumeOf = async () =>
		host.evaluate(() => {
			const el = document.querySelector('audio');
			return el === null ? null : { volume: el.volume, muted: el.muted };
		});
	await expect.poll(volumeOf).toEqual({ volume: 1, muted: false });

	// Turn them down.
	await host.getByRole('slider', { name: 'Volume for Talker' }).fill('0.25');
	await expect.poll(volumeOf).toEqual({ volume: 0.25, muted: false });

	// And mute them entirely.
	await mute.click();
	await expect.poll(async () => (await volumeOf())?.muted).toBe(true);

	/*
	 * PER VIEWER, and this is the assertion that matters most.
	 *
	 * Nothing about this reached the other person: the speaker sees no control
	 * on their own avatar, is never told, and their own mic state is untouched.
	 * A mute that leaked into room state would be a moderation feature wearing a
	 * listening feature's clothes.
	 */
	await expect(guest.getByRole('button', { name: /for yourself/ })).toHaveCount(0);
	await expect(guest.getByRole('button', { name: 'Mute' })).toBeVisible();

	await hostCtx.close();
	await guestCtx.close();
});
