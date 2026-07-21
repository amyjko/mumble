import { expect, test } from '@playwright/test';
import { hostFurnishedRoom } from './support/auth';
import { roomName } from './support/join';

/**
 * A room arrives furnished (UX-ROOM-12).
 *
 * The unit tests own the geometry — that no two spots overlap, that each layout
 * states both its placers and its capacity. What only an end-to-end test can
 * show is that the seeding write actually LANDED: `defaultRoomState` is a pure
 * function, and a room whose furniture never left the server would pass every
 * spec in `presets.spec.ts` and greet its host with an empty canvas.
 */
test('a new room is furnished, and its layouts switch (UX-ROOM-12)', async ({ page }) => {
	await hostFurnishedRoom(page, roomName('preset'));

	// Five equal spots and a chat: the gallery, active on arrival.
	await expect(page.getByRole('group', { name: /Newcomer 5/ })).toBeVisible();
	await expect(page.getByRole('group', { name: /Newcomer 6/ })).toHaveCount(0);
	await expect(page.getByRole('group', { name: /^Chat/ })).toBeVisible();
	// Capacity is a separate fact from placement (UX-STAGE-1): five spots are
	// only five video spots because the layout also says max_av = 5.
	await expect(page.getByLabel('Stage capacity')).toContainText('0/5 video');

	// All three layouts are offered, by name.
	await page.getByRole('button', { name: /layouts/ }).click();
	for (const name of ['Gallery', 'One on one', 'Featured speaker']) {
		await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
	}

	// Switching is a real configuration switch: spots, capacity and content all
	// change together, because a layout is all three at once (UX-ROOM-3).
	await page.getByRole('button', { name: 'One on one', exact: true }).click();
	await expect(page.getByRole('group', { name: /Newcomer 2/ })).toBeVisible();
	await expect(page.getByRole('group', { name: /Newcomer 3/ })).toHaveCount(0);
	await expect(page.getByLabel('Stage capacity')).toContainText('0/2 video');

	await page.getByRole('button', { name: 'Featured speaker', exact: true }).click();
	await expect(page.getByRole('group', { name: /Newcomer 36/ })).toBeVisible();
	// One speaker on camera, and an audience that may be heard (max_audio 35).
	await expect(page.getByLabel('Stage capacity')).toContainText('0/1 video');
	await expect(page.getByLabel('Stage capacity')).toContainText('0/35 audio');
});
