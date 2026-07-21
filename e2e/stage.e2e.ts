import { expect, test } from '@playwright/test';
import { joinRoom, roomName, SYNC } from './support/join';
import { hostRoom } from './support/auth';

/**
 * The stage (UX-STAGE). Control plane only — a slot is AUTHORIZATION, not
 * activation (UX-STAGE-6), which is exactly why all of this is buildable and
 * testable before any media exists.
 */

test('stage: taking a video slot updates the readout and the avatar', async ({ page }) => {
	await hostRoom(page, roomName('stage'));

	// UX-STAGE-9: scarcity is legible before you bump into it.
	const readout = page.getByLabel('Stage capacity');
	await expect(readout).toContainText('0/4 video');

	await page.getByRole('button', { name: /Turn camera on/ }).click();
	await expect(readout).toContainText('1/4 video');
	// ...and who holds what is shown on the participant, never inferred.
	await expect(page.getByRole('img', { name: 'holds a video slot' })).toBeVisible();

	await page.getByRole('button', { name: /Turn camera off/ }).click();
	await expect(readout).toContainText('0/4 video');
});

test('stage: the hand appears only under contention (UX-AV-6)', async ({ page }) => {
	await hostRoom(page, roomName('conch'));

	// With slots free you simply take one, so a queue control would be noise.
	await expect(page.getByRole('button', { name: /hand/i })).toHaveCount(0);

	// Make the room a conch with no audio: one video slot, and take it.
	await page.getByRole('button', { name: /^stage/ }).click();
	await page.getByRole('textbox', { name: 'Video slots' }).fill('1');
	await page.getByRole('textbox', { name: 'Video slots' }).blur();
	await page.getByRole('textbox', { name: 'Audio slots' }).fill('0');
	await page.getByRole('textbox', { name: 'Audio slots' }).blur();
	await page.keyboard.press('Escape');

	await page.getByRole('button', { name: /Turn camera on/ }).click();
	await expect(page.getByLabel('Stage capacity')).toContainText('1/1 video');

	// Now nothing is free, so the queue control appears.
	await expect(page.getByRole('button', { name: /raise your hand|Raise hand/i })).toBeVisible();
});

test('stage: muting frees the audio slot, and the readout says so (UX-STAGE-10)', async ({ page }) => {
	await hostRoom(page, roomName('mute'));
	const readout = page.getByLabel('Stage capacity');

	await page.getByRole('button', { name: 'Unmute' }).click();
	await expect(readout).toContainText('1/8 audio');

	// Muting releases it unconditionally — DESIGN.md's deliberate sharp edge.
	await page.getByRole('button', { name: /Mute \(frees your audio slot\)/ }).click();
	await expect(readout).toContainText('0/8 audio');
});

test('stage: a video holder muting keeps the video slot (the exception)', async ({ page }) => {
	await hostRoom(page, roomName('vidmute'));
	const readout = page.getByLabel('Stage capacity');

	await page.getByRole('button', { name: /Turn camera on/ }).click();
	await page.getByRole('button', { name: 'Unmute' }).click();

	// Video already authorizes audio, so unmuting consumed NO audio slot.
	await expect(readout).toContainText('1/4 video');
	await expect(readout).toContainText('0/8 audio');

	// And the mic label says what muting will actually do here.
	await expect(page.getByRole('button', { name: /Mute \(keeps your video slot\)/ })).toBeVisible();
});

/**
 * The host's escape hatch, which had no UI at all until 2026-07-20 (UX-STAGE-4).
 *
 * `grant_slot` and `revoke_slot` existed in the rule engine, were host-gated
 * server-side, and were reachable only from tests — so the requirement's "a
 * host may grant, revoke, or preempt any slot directly" was true of the system
 * and false of the product. These controls live on the avatar rather than in a
 * menu because passing the floor is the most frequent act in a conch room.
 *
 * Two contexts, because a host acting on THEMSELVES would prove nothing: the
 * whole point is one person changing what another person may publish.
 */
test('a host grants and revokes a slot on someone else (UX-STAGE-4)', async ({ browser }) => {
	const room = roomName('grant');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	await hostRoom(host, room);
	await joinRoom(guest, room, 'Guest');

	// The host must be able to see the guest before acting on them.
	await expect(host.locator('.avatar')).toHaveCount(2, { timeout: SYNC });

	const readout = guest.getByLabel('Stage capacity');
	await expect(readout).toContainText('0/4 video');

	// Granting is one click, on the avatar, with no menu in the way.
	await host.getByRole('button', { name: 'Give Guest a video slot' }).click();

	// The GUEST's own view is where it has to be true: their readout moves and
	// their avatar carries the badge UX-STAGE-9 requires.
	await expect(readout).toContainText('1/4 video', { timeout: SYNC });
	await expect(guest.getByRole('img', { name: 'holds a video slot' })).toBeVisible({
		timeout: SYNC
	});

	// And revoking takes it back — the same control, now inverted.
	await host.getByRole('button', { name: "Revoke Guest's video slot" }).click();
	await expect(readout).toContainText('0/4 video', { timeout: SYNC });

	await hostCtx.close();
	await guestCtx.close();
});

/**
 * The gate is real, not decorative.
 *
 * A guest seeing these controls would be offered something the server refuses
 * (`requireHostForRoom`), which is the "control that can only ever fail" this
 * codebase already rejected for the rename field.
 */
test('a guest is offered no slot controls over anyone', async ({ browser }) => {
	const room = roomName('nogrant');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	await hostRoom(host, room);
	await joinRoom(guest, room, 'Guest');
	await expect(guest.locator('.avatar')).toHaveCount(2, { timeout: SYNC });

	// The guest can see the host's avatar and has no power over it...
	await expect(guest.getByRole('button', { name: /Give Host a video slot/ })).toHaveCount(0);
	// ...and the host's own view proves the controls exist to be missing.
	await expect(host.getByRole('button', { name: 'Give Guest a video slot' })).toBeVisible();

	await hostCtx.close();
	await guestCtx.close();
});

/**
 * Nobody gets slot controls over themselves.
 *
 * A host already has camera and mic buttons in the bottom bar; a second pair
 * meaning the same thing somewhere else is how someone ends up unsure which one
 * releases a slot.
 */
test('a host has no slot controls on their own avatar', async ({ page }) => {
	await hostRoom(page, roomName('noself'));
	await expect(page.getByRole('group', { name: /^Slots for/ })).toHaveCount(0);
});
