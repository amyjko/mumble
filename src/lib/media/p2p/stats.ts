import { z } from 'zod';
import type { PeerId, PeerState, TransportStats } from '$lib/media/transport';

/**
 * The normalised stats surface (AR-TRANSPORT-5, AR-COST-9).
 *
 * Its own file for a specific reason: `getStats()` hands back entries typed as
 * `any` in lib.dom, and `as` is banned here. Touching a field directly fires the
 * whole `no-unsafe-*` family. So every entry is laundered to `unknown` and
 * zod-parsed, which is the same discipline applied to peer messages elsewhere —
 * a stats report from a browser is untrusted input in exactly the way a
 * broadcast is, just for reliability rather than security reasons.
 *
 * Pure over a plain iterable, so it is testable in node with hand-written
 * entries and no peer connection.
 *
 * Every output field is nullable, and that is a design position: a transport
 * that cannot measure something reports null rather than zero, because zero is
 * a claim and "not available yet" is not.
 */

/** Parsed leniently: a field absent from one browser must not void the report. */
const z_candidatePair = z.object({
	type: z.literal('candidate-pair'),
	state: z.string().optional(),
	nominated: z.boolean().optional(),
	currentRoundTripTime: z.number().optional(),
	localCandidateId: z.string().optional(),
	remoteCandidateId: z.string().optional()
});

const z_candidate = z.object({
	type: z.enum(['local-candidate', 'remote-candidate']),
	id: z.string(),
	candidateType: z.string().optional()
});

const z_outbound = z.object({
	type: z.literal('outbound-rtp'),
	kind: z.string().optional(),
	bytesSent: z.number().optional(),
	timestamp: z.number().optional(),
	framesEncoded: z.number().optional(),
	framesSent: z.number().optional()
});

const z_remoteInbound = z.object({
	type: z.literal('remote-inbound-rtp'),
	packetsLost: z.number().optional(),
	packetsReceived: z.number().optional()
});

const z_inbound = z.object({
	type: z.literal('inbound-rtp'),
	packetsLost: z.number().optional(),
	packetsReceived: z.number().optional()
});

/** Carried between calls so a bitrate can be a rate rather than a total. */
export interface StatsSample {
	readonly bytesSent: number;
	readonly timestampMs: number;
}

export interface Normalised {
	readonly stats: TransportStats;
	/** Feed back into the next call. Null when nothing was measurable. */
	readonly sample: StatsSample | null;
}

function ratio(lost: number | undefined, received: number | undefined): number | null {
	if (lost === undefined || received === undefined) return null;
	const total = lost + received;
	// No packets is not zero loss — it is no measurement.
	if (total <= 0) return null;
	return Math.min(1, Math.max(0, lost / total));
}

export function normaliseStats(
	peer: PeerId,
	state: PeerState,
	entries: Iterable<unknown>,
	previous: StatsSample | null = null
): Normalised {
	let rttMs: number | null = null;
	let relayed: boolean | null = null;
	let outboundLossRatio: number | null = null;
	let inboundLossRatio: number | null = null;
	let encoderDropRatio: number | null = null;
	let bytesSent: number | null = null;
	let timestampMs: number | null = null;

	// Candidate ids are resolved in a second pass: the pair names them, and the
	// entries describing them may arrive in any order.
	const candidateTypes = new Map<string, string>();
	let activeLocalId: string | null = null;
	let activeRemoteId: string | null = null;

	for (const entry of entries) {
		const pair = z_candidatePair.safeParse(entry);
		if (pair.success) {
			// `nominated` is the pair actually carrying media; some browsers report
			// several succeeded pairs and only one that counts.
			const inUse = pair.data.nominated === true || pair.data.state === 'succeeded';
			if (!inUse) continue;
			if (pair.data.currentRoundTripTime !== undefined) {
				rttMs = pair.data.currentRoundTripTime * 1000;
			}
			activeLocalId = pair.data.localCandidateId ?? null;
			activeRemoteId = pair.data.remoteCandidateId ?? null;
			continue;
		}

		const candidate = z_candidate.safeParse(entry);
		if (candidate.success) {
			const kind = candidate.data.candidateType;
			if (kind !== undefined) candidateTypes.set(candidate.data.id, kind);
			continue;
		}

		const outbound = z_outbound.safeParse(entry);
		if (outbound.success) {
			if (outbound.data.bytesSent !== undefined) {
				bytesSent = (bytesSent ?? 0) + outbound.data.bytesSent;
			}
			if (outbound.data.timestamp !== undefined) timestampMs = outbound.data.timestamp;
			const encoded = outbound.data.framesEncoded;
			const sent = outbound.data.framesSent;
			if (encoded !== undefined && sent !== undefined && encoded > 0) {
				encoderDropRatio = Math.min(1, Math.max(0, (encoded - sent) / encoded));
			}
			continue;
		}

		const remoteInbound = z_remoteInbound.safeParse(entry);
		if (remoteInbound.success) {
			outboundLossRatio = ratio(remoteInbound.data.packetsLost, remoteInbound.data.packetsReceived);
			continue;
		}

		const inbound = z_inbound.safeParse(entry);
		if (inbound.success) {
			inboundLossRatio = ratio(inbound.data.packetsLost, inbound.data.packetsReceived);
		}
	}

	/*
	 * THE number AR-COST-9 asks for. Either end being a relay means the traffic
	 * is going through TURN and costing money, which is why this is an OR rather
	 * than a check of the local end alone.
	 */
	if (activeLocalId !== null || activeRemoteId !== null) {
		const local = activeLocalId === null ? undefined : candidateTypes.get(activeLocalId);
		const remote = activeRemoteId === null ? undefined : candidateTypes.get(activeRemoteId);
		if (local !== undefined || remote !== undefined) {
			relayed = local === 'relay' || remote === 'relay';
		}
	}

	let sendBitrateBps: number | null = null;
	const sample =
		bytesSent === null || timestampMs === null ? null : { bytesSent, timestampMs };
	if (sample !== null && previous !== null) {
		const seconds = (sample.timestampMs - previous.timestampMs) / 1000;
		const delta = sample.bytesSent - previous.bytesSent;
		// A counter that went backwards means the connection restarted; report
		// nothing rather than a negative rate.
		if (seconds > 0 && delta >= 0) sendBitrateBps = (delta * 8) / seconds;
	}

	return {
		stats: {
			peer,
			state,
			rttMs,
			outboundLossRatio,
			inboundLossRatio,
			sendBitrateBps,
			encoderDropRatio,
			relayed
		},
		sample
	};
}
