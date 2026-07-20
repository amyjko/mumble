import { expect, test } from '@playwright/test';
import { SYNC, joinRoom, roomName, settled } from './support/join';
import { adminClient, hostRoom } from './support/auth';

/**
 * Liveness (AR-CTRL-3, UX-STAGE-4).
 *
 * A participant row outlives the tab that wrote it, so without this a closed
 * laptop leaves someone "in" the room forever — and still holding their slot.
 * At `max_av = 1` that slot is the conch, so one crashed tab would silence the
 * room until a human noticed.
 *
 * Realtime already knows when a socket drops, which is why this needs no
 * heartbeat table and no polling: the connection IS the liveness signal.
 */

test('a closed tab frees the slot it was holding', async ({ browser }) => {
	const room = roomName('ghost');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	// The HOST stays: reaping is host-only, because `remove_participant` is
	// self-or-host on the server and a guest attempting it is refused.
	await hostRoom(host, room);
	await settled(host);

	const admin = adminClient();
	const roomRow = await admin.from('rooms').select('id').eq('name', room).single();
	const roomId = roomRow.data?.id ?? '';
	expect(roomId).not.toBe('');

	await joinRoom(guest, room, 'Departing');
	await settled(guest);

	// The guest takes the conch.
	await guest.getByRole('button', { name: /Turn camera on/ }).click();
	await settled(guest);

	const holders = async (): Promise<string[]> => {
		const row = await admin
			.from('room_state')
			.select('video_holders')
			.eq('room_id', roomId)
			.single();
		return row.data?.video_holders ?? [];
	};
	expect(await holders()).toHaveLength(1);

	// The tab goes away — not a graceful "leave" button, the case that actually
	// breaks rooms.
	await guestCtx.close();

	// The host's client sees the presence leave and reaps them, which releases
	// the slot through the rule engine's own `participantLeft`.
	await expect.poll(holders, { timeout: SYNC }).toEqual([]);

	await hostCtx.close();
});

test('a participant who is merely quiet is NOT reaped', async ({ browser }) => {
	// The failure mode on the other side: reaping someone who is still there
	// takes the conch from a person sitting in the room. Presence is keyed on
	// the connection, not on activity, so doing nothing must be safe.
	const room = roomName('quiet');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	await hostRoom(host, room);
	await settled(host);
	await joinRoom(guest, room, 'Quiet');
	await settled(guest);

	await guest.getByRole('button', { name: /Turn camera on/ }).click();
	await settled(guest);

	const admin = adminClient();
	const roomRow = await admin.from('rooms').select('id').eq('name', room).single();
	const roomId = roomRow.data?.id ?? '';

	// Long enough that a leave would have been noticed and acted on.
	await host.waitForTimeout(4000);

	const row = await admin.from('room_state').select('video_holders').eq('room_id', roomId).single();
	expect(row.data?.video_holders).toHaveLength(1);

	await hostCtx.close();
	await guestCtx.close();
});
