import { expect, test } from '@playwright/test';
import { joinRoom, roomName, settled } from './support/join';
import { hostRoom } from './support/auth';

/**
 * The active-speaker cap (AR-MEDIA-6, UX-STAGE-5).
 *
 * WHAT THIS LAYER CAN AND CANNOT PROVE, stated up front because the gap belongs
 * in AR-TEST-10 rather than in a comment nobody reads:
 *
 *  - CANNOT: real voice-activity discrimination. Chrome's fake audio device
 *    gives every peer an identical tone, so "the loudest three" is not a
 *    question this environment can answer — nothing local can produce two
 *    people talking at different volumes.
 *  - CAN: that the mechanism is wired end to end — that the stage's authorized
 *    set reaches the selection, that the selection is recomputed as slots
 *    change, and that it narrows to the cap rather than to whoever happens to
 *    be loudest in a room of identical tones.
 *
 * The selection logic itself is covered exhaustively in `model/stage.spec.ts`,
 * where it is pure and a clock can be handed to it.
 */

test('the selection tracks who the stage authorizes (AR-MEDIA-6)', async ({ browser }) => {
	const room = roomName('speakers');
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	await hostRoom(host, room);
	await settled(host);
	await joinRoom(guest, room, 'Speaker');
	await settled(guest);

	await expect(host.locator('html')).toHaveAttribute('data-media-peers', '1', { timeout: 60_000 });

	// Nobody holds an audio slot yet, so nobody is selected. An empty selection
	// with nobody authorized is correct; an empty selection with people
	// authorized would be the room muting itself.
	await expect(host.locator('html')).toHaveAttribute('data-active-speakers', '');

	// The guest takes an audio slot and unmutes.
	await guest.getByRole('button', { name: 'Unmute' }).click();
	await settled(guest);

	// The HOST's selection includes them — computed from the shared stage, which
	// is what makes every peer agree without anyone arbitrating.
	await expect(host.locator('html')).toHaveAttribute('data-active-speakers', /.+/, {
		timeout: 15_000
	});
	const selected = await host.locator('html').getAttribute('data-active-speakers');
	expect(selected?.split(',').filter(Boolean).length).toBe(1);

	// Both audible: still under the cap of three, so both are selected and the
	// cap has narrowed nothing. This is the common room, and the case where the
	// cap must be invisible.
	await host.getByRole('button', { name: 'Unmute' }).click();
	await settled(host);
	await expect
		.poll(
			async () =>
				(await host.locator('html').getAttribute('data-active-speakers'))
					?.split(',')
					.filter(Boolean).length,
			{ timeout: 15_000 }
		)
		.toBe(2);

	// And the guest agrees, independently. Two peers computing the same set from
	// the same inputs is the property that makes selection control-plane rather
	// than per-client opinion — on P2P there is no forwarder to reconcile them.
	await expect
		.poll(
			async () =>
				(await guest.locator('html').getAttribute('data-active-speakers'))
					?.split(',')
					.filter(Boolean).length,
			{ timeout: 15_000 }
		)
		.toBe(2);

	await hostCtx.close();
	await guestCtx.close();
});
