import { describe, expect, it } from 'vitest';
import { normaliseStats } from './stats';

/**
 * Stats normalisation, tested against hand-written entries.
 *
 * No peer connection: the interesting behaviour is arithmetic and the
 * distinction between "zero" and "no measurement", both of which a real report
 * would only obscure. What a browser actually emits is covered by the in-page
 * transport test.
 */

const PEER = 'peer-1';

describe('the relay flag (AR-COST-9)', () => {
	it('is true when either end is a relay', () => {
		// With a P2P MVP this is the only media spend the product carries, and
		// either end relaying means the traffic is going through TURN.
		const relayLocal = normaliseStats(PEER, 'connected', [
			{ type: 'candidate-pair', nominated: true, localCandidateId: 'L', remoteCandidateId: 'R' },
			{ type: 'local-candidate', id: 'L', candidateType: 'relay' },
			{ type: 'remote-candidate', id: 'R', candidateType: 'srflx' }
		]);
		expect(relayLocal.stats.relayed).toBe(true);

		const relayRemote = normaliseStats(PEER, 'connected', [
			{ type: 'candidate-pair', nominated: true, localCandidateId: 'L', remoteCandidateId: 'R' },
			{ type: 'local-candidate', id: 'L', candidateType: 'host' },
			{ type: 'remote-candidate', id: 'R', candidateType: 'relay' }
		]);
		expect(relayRemote.stats.relayed).toBe(true);
	});

	it('is false for a direct pair', () => {
		const direct = normaliseStats(PEER, 'connected', [
			{ type: 'candidate-pair', nominated: true, localCandidateId: 'L', remoteCandidateId: 'R' },
			{ type: 'local-candidate', id: 'L', candidateType: 'host' },
			{ type: 'remote-candidate', id: 'R', candidateType: 'host' }
		]);
		expect(direct.stats.relayed).toBe(false);
	});

	it('is NULL when the candidates are unknown, not false', () => {
		// "We could not tell" and "it is not relayed" are different claims, and
		// billing decisions should not be made on the first one dressed as the
		// second.
		const unknown = normaliseStats(PEER, 'connected', [
			{ type: 'candidate-pair', nominated: true, localCandidateId: 'L', remoteCandidateId: 'R' }
		]);
		expect(unknown.stats.relayed).toBeNull();
	});

	it('ignores a pair that is not the one in use', () => {
		// Browsers report every pair they tried; only the nominated one carries
		// media, and reading a failed relay pair would report a cost never paid.
		const stats = normaliseStats(PEER, 'connected', [
			{ type: 'candidate-pair', state: 'failed', localCandidateId: 'X', remoteCandidateId: 'Y' },
			{ type: 'local-candidate', id: 'X', candidateType: 'relay' },
			{ type: 'candidate-pair', nominated: true, localCandidateId: 'L', remoteCandidateId: 'R' },
			{ type: 'local-candidate', id: 'L', candidateType: 'host' },
			{ type: 'remote-candidate', id: 'R', candidateType: 'host' }
		]);
		expect(stats.stats.relayed).toBe(false);
	});
});

describe('loss', () => {
	it('is a ratio of lost to total, both directions', () => {
		const stats = normaliseStats(PEER, 'connected', [
			{ type: 'remote-inbound-rtp', packetsLost: 5, packetsReceived: 95 },
			{ type: 'inbound-rtp', packetsLost: 1, packetsReceived: 99 }
		]);
		expect(stats.stats.outboundLossRatio).toBeCloseTo(0.05);
		expect(stats.stats.inboundLossRatio).toBeCloseTo(0.01);
	});

	it('reports null rather than zero when nothing has flowed', () => {
		// A connection that has sent nothing has not achieved perfect delivery.
		const stats = normaliseStats(PEER, 'connecting', [
			{ type: 'inbound-rtp', packetsLost: 0, packetsReceived: 0 }
		]);
		expect(stats.stats.inboundLossRatio).toBeNull();
	});
});

describe('send bitrate', () => {
	it('needs two samples, and is null on the first', () => {
		const first = normaliseStats(PEER, 'connected', [
			{ type: 'outbound-rtp', bytesSent: 1_000, timestamp: 1_000 }
		]);
		expect(first.stats.sendBitrateBps).toBeNull();
		expect(first.sample).toEqual({ bytesSent: 1_000, timestampMs: 1_000 });
	});

	it('is a rate over the interval, in bits', () => {
		const second = normaliseStats(
			PEER,
			'connected',
			[{ type: 'outbound-rtp', bytesSent: 13_500, timestamp: 2_000 }],
			{ bytesSent: 1_000, timestampMs: 1_000 }
		);
		// 12500 bytes over 1s = 100_000 bps.
		expect(second.stats.sendBitrateBps).toBeCloseTo(100_000);
	});

	it('refuses to report a negative rate when a counter resets', () => {
		// An ICE restart resets counters; a negative bitrate is not a measurement.
		const reset = normaliseStats(
			PEER,
			'connected',
			[{ type: 'outbound-rtp', bytesSent: 10, timestamp: 2_000 }],
			{ bytesSent: 999_999, timestampMs: 1_000 }
		);
		expect(reset.stats.sendBitrateBps).toBeNull();
	});

	it('sums every outbound stream, since a peer may carry video and audio', () => {
		const stats = normaliseStats(PEER, 'connected', [
			{ type: 'outbound-rtp', kind: 'video', bytesSent: 1_000, timestamp: 5_000 },
			{ type: 'outbound-rtp', kind: 'audio', bytesSent: 500, timestamp: 5_000 }
		]);
		expect(stats.sample?.bytesSent).toBe(1_500);
	});
});

describe('robustness', () => {
	it('survives entries it does not recognise', () => {
		// A browser reports many stat types and adds more over time; an unknown
		// one must not void the report.
		const stats = normaliseStats(PEER, 'connected', [
			{ type: 'certificate', fingerprint: 'ab:cd' },
			{ type: 'some-future-thing', value: 1 },
			null,
			'nonsense',
			42,
			{ type: 'remote-inbound-rtp', packetsLost: 1, packetsReceived: 9 }
		]);
		expect(stats.stats.outboundLossRatio).toBeCloseTo(0.1);
	});

	it('reports the peer and state it was given, always', () => {
		const stats = normaliseStats(PEER, 'interrupted', []);
		expect(stats.stats.peer).toBe(PEER);
		// `interrupted` is deliberately distinct from `failed`: ICE disconnects
		// routinely recover, and a UI saying "call failed" on a blip is lying.
		expect(stats.stats.state).toBe('interrupted');
		expect(stats.stats.rttMs).toBeNull();
	});
});
