import { expect, test } from '@playwright/test';
import { joinRoom, roomName } from './support/join';

/**
 * The stage (UX-STAGE). Control plane only — a slot is AUTHORIZATION, not
 * activation (UX-STAGE-6), which is exactly why all of this is buildable and
 * testable before any media exists.
 */

test('stage: taking a video slot updates the readout and the avatar', async ({ page }) => {
	await joinRoom(page, roomName('stage'));

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
	await joinRoom(page, roomName('conch'));

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
	await joinRoom(page, roomName('mute'));
	const readout = page.getByLabel('Stage capacity');

	await page.getByRole('button', { name: 'Unmute' }).click();
	await expect(readout).toContainText('1/8 audio');

	// Muting releases it unconditionally — DESIGN.md's deliberate sharp edge.
	await page.getByRole('button', { name: /Mute \(frees your audio slot\)/ }).click();
	await expect(readout).toContainText('0/8 audio');
});

test('stage: a video holder muting keeps the video slot (the exception)', async ({ page }) => {
	await joinRoom(page, roomName('vidmute'));
	const readout = page.getByLabel('Stage capacity');

	await page.getByRole('button', { name: /Turn camera on/ }).click();
	await page.getByRole('button', { name: 'Unmute' }).click();

	// Video already authorizes audio, so unmuting consumed NO audio slot.
	await expect(readout).toContainText('1/4 video');
	await expect(readout).toContainText('0/8 audio');

	// And the mic label says what muting will actually do here.
	await expect(page.getByRole('button', { name: /Mute \(keeps your video slot\)/ })).toBeVisible();
});
