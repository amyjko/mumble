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

test('the sweep clears a ghost even with no host watching', async ({ browser }) => {
	/*
	 * The hole presence cannot cover, and the reason the heartbeat exists.
	 *
	 * Presence-driven reaping is client-side and HOST-only, so a room whose only
	 * host has gone keeps its ghosts — and at `max_av = 1` a ghost holds the
	 * conch, leaving the room silent until a human intervenes.
	 *
	 * Here the holder's tab is closed AND the host leaves. Nobody is left who
	 * could reap by presence; the only thing that can clean the room is the
	 * sweep the remaining guest's own heartbeat triggers.
	 */
	const room = roomName('sweep');
	const hostCtx = await browser.newContext();
	const goneCtx = await browser.newContext();
	const stayCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const gone = await goneCtx.newPage();
	const stay = await stayCtx.newPage();

	await hostRoom(host, room);
	await settled(host);

	const admin = adminClient();
	const roomRow = await admin.from('rooms').select('id').eq('name', room).single();
	const roomId = roomRow.data?.id ?? '';

	await joinRoom(gone, room, 'Vanishing');
	await settled(gone);
	await joinRoom(stay, room, 'Remaining');
	await settled(stay);

	await gone.getByRole('button', { name: /Turn camera on/ }).click();
	await settled(gone);

	const holders = async (): Promise<string[]> => {
		const row = await admin.from('room_state').select('video_holders').eq('room_id', roomId).single();
		return row.data?.video_holders ?? [];
	};
	expect(await holders()).toHaveLength(1);

	const holderId = (await holders())[0] ?? '';

	/*
	 * ORDER MATTERS, and getting it wrong would make this test prove nothing.
	 *
	 * The host goes FIRST. If the holder's tab closed while a host were still
	 * watching, presence would reap them within a second and this would pass
	 * without the sweep ever running — a test of the feature it is not for.
	 */
	await hostCtx.close();
	await stay.waitForTimeout(500);

	// Now the holder vanishes, with nobody left who is able to reap by presence.
	await goneCtx.close();

	// Backdated AFTER the tab is gone, or the holder's own heartbeat would keep
	// refreshing it. Backdating rather than waiting 45s keeps this a test of the
	// SWEEP rather than of the clock.
	await admin
		.from('room_participants')
		.update({ last_seen: new Date(Date.now() - 120_000).toISOString() })
		.eq('room_id', roomId)
		.eq('id', holderId);

	// The remaining guest is not a host and cannot reap anyone. Their heartbeat
	// is what cleans the room.
	await expect.poll(holders, { timeout: 30_000, intervals: [1000] }).toEqual([]);

	await stayCtx.close();
});
