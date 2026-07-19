import { expect, test } from '@playwright/test';
import { SYNC, joinRoom, roomName } from './support/join';

/**
 * Timer object (UX-OBJ-4): created pointer-free, ticks, and shows the SAME
 * running state to a second viewer — via the shared payload, not per-client
 * clocks.
 */
test('timer: create, start, ticks, and syncs running state to a peer', async ({ browser }) => {
	const room = roomName('timer');
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await joinRoom(a, room);
	await a.getByRole('button', { name: '+ timer' }).click();

	const readoutA = a.locator('.timer .readout');
	await expect(readoutA).toHaveText('05:00');

	// Start it; the countdown should drop below 5:00 within a couple seconds.
	await a.getByRole('button', { name: 'Start' }).click();
	await expect.poll(async () => readoutA.textContent(), { timeout: 4000 }).not.toBe('05:00');

	// A second viewer sees the timer, running (Pause shown = it's running).
	await joinRoom(b, room);
	await expect(b.locator('.timer .readout')).toBeVisible({ timeout: SYNC });
	await expect(b.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: SYNC });

	await context.close();
});
