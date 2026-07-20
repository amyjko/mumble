import { describe, expect, it } from 'vitest';
import { NullTransport } from './null-transport';
import type { MediaTransport } from './transport';

/**
 * The transport that does nothing (AR-TRANSPORT-10).
 *
 * It exists so the seam had two implementations before either was real, which is
 * the only thing that ever keeps an interface honest — `MemoryRoomStore` is why
 * `RoomStore` came out clean. It is also `MediaSession`'s default, so a page that
 * never establishes a session behaves exactly as it did before any of this
 * existed.
 *
 * Untested until now, and that was the risk: a null object with no caller and no
 * test drifts out of sync with the interface it is supposed to satisfy, and
 * nothing says so until someone needs it. These assertions are deliberately
 * shallow — the point is that every method EXISTS, resolves, and refuses to
 * invent state.
 *
 * In the browser project rather than node, for one reason: `publish` takes a
 * `MediaStreamTrack`, and faking one would need a type assertion, which this
 * codebase bans. An oscillator gives a real track for free.
 */

/** A real track, so no cast is needed. Deterministic and permission-free. */
function tone(): MediaStreamTrack {
	const context = new AudioContext();
	const oscillator = context.createOscillator();
	const destination = context.createMediaStreamDestination();
	oscillator.connect(destination);
	oscillator.start();
	const track = destination.stream.getAudioTracks()[0];
	if (track === undefined) throw new Error('no audio track');
	return track;
}

function transport(): MediaTransport {
	// Typed as the interface on purpose: if `NullTransport` stops satisfying
	// `MediaTransport`, this file stops compiling, which is most of the value.
	return new NullTransport();
}

describe('doing nothing, completely', () => {
	it('accepts the whole surface without throwing', async () => {
		const t = transport();
		const track = tone();

		await t.addPeer('peer-a');
		const publication = await t.publish('video', track);
		await t.subscribe('peer-a', 'video', 'high');
		await t.setLayer('peer-a', 'video', 'low');
		await t.pause('peer-a', 'video');
		await t.resume('peer-a', 'video');
		await t.unsubscribe('peer-a', 'video');
		await t.unpublish(publication);
		await t.removePeer('peer-a');

		expect(publication).toBeTypeOf('string');
	});

	it('reports peers it was told about, as closed', async () => {
		/*
		 * The one thing it does track. A null transport that reported NO peers
		 * would make `stats()` a lie in the opposite direction — a caller asking
		 * "how many connections do I have" is owed an answer about the peers it
		 * added, and `closed` is the truthful one.
		 */
		const t = transport();
		await t.addPeer('peer-a');
		await t.addPeer('peer-b');

		const stats = await t.stats();
		expect(stats).toHaveLength(2);
		expect(stats.map((s) => s.peer).sort()).toEqual(['peer-a', 'peer-b']);
		for (const one of stats) expect(one.state).toBe('closed');
	});

	it('measures nothing rather than measuring zero', async () => {
		// Null is "no measurement"; zero is a claim. A transport that never
		// connected has not achieved a round trip time of 0ms.
		const t = transport();
		await t.addPeer('peer-a');
		const [stats] = await t.stats();
		expect(stats?.rttMs).toBeNull();
		expect(stats?.relayed).toBeNull();
		expect(stats?.sendBitrateBps).toBeNull();
	});

	it('forgets a removed peer', async () => {
		const t = transport();
		await t.addPeer('peer-a');
		await t.removePeer('peer-a');
		expect(await t.stats()).toEqual([]);
	});

	it('hands back working unsubscribers that never fire', async () => {
		// A caller must be able to unsubscribe without a special case, which is
		// the whole argument for a null object over a nullable transport.
		const t = transport();
		expect(t.onRemoteTrack(() => undefined)).toBeTypeOf('function');
		expect(t.onTrackEnded(() => undefined)).toBeTypeOf('function');
		expect(t.onPeerState(() => undefined)).toBeTypeOf('function');
		t.onRemoteTrack(() => undefined)();
		t.dispose();
		expect(await t.stats()).toEqual([]);
	});
});
