import { z } from 'zod';
import { grantSchema } from '$lib/media/grant';

/**
 * What rides the store's addressed channel (AR-BACKEND-2, AR-TRANSPORT-1).
 *
 * This vocabulary lives HERE rather than in `model/schemas.ts` deliberately.
 * The store's `sendSignal` takes `unknown` and never reads it, so media shapes
 * never enter the model layer and the canvas's ephemeral union stays canvas
 * vocabulary. Everything below is parsed at the boundary before it is trusted,
 * the same discipline every other inbound path in this codebase applies.
 *
 * Nothing here is authenticated by transport. A backend can prove a sender
 * belongs to the room; it cannot prove they are who they claim. The signed
 * publish grant is what closes that, which is why an offer carries one.
 */

/** Bounded, because these arrive from peers and unbounded strings are a gift. */
const MAX_SDP = 64_000;
const MAX_CANDIDATE = 1024;

export const signalSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('description'),
		type: z.enum(['offer', 'answer']),
		sdp: z.string().max(MAX_SDP),
		/**
		 * Present on an offer that adds a sending track; verified by the receiver
		 * against the live holder list before it is answered.
		 */
		grant: grantSchema.optional()
	}),
	z.object({
		kind: z.literal('candidates'),
		/*
		 * Batched. Candidates arrive in bursts and AR-BACKEND-5 counts messages
		 * rather than bytes, so one frame of many beats many frames of one.
		 */
		items: z
			.array(
				z.object({
					candidate: z.string().max(MAX_CANDIDATE),
					/*
					 * `.nullable()`, never `.optional()`. These map onto W3C
					 * dictionaries whose fields are `string | null`, and under
					 * `exactOptionalPropertyTypes` an optional field cannot be spread
					 * into one that accepts null.
					 */
					sdpMid: z.string().nullable(),
					sdpMLineIndex: z.number().int().nullable(),
					usernameFragment: z.string().nullable()
				})
			)
			.max(32)
	}),
	/**
	 * A subscriber naming the rung it wants, and pausing.
	 *
	 * On P2P the publisher encodes per peer (AR-MEDIA-3), so a subscription
	 * preference has to travel publisher-ward — there is no forwarder in the
	 * middle to make the choice. This message is the mechanism `transport.ts`
	 * refuses to expose: above the seam a caller says `subscribe(peer, kind,
	 * layer)` and never learns that a message was sent at all.
	 *
	 * `layer: null` means stop sending, which collapses unsubscribe and pause
	 * into one message and one publisher-side action.
	 */
	z.object({
		kind: z.literal('want'),
		media: z.enum(['video', 'audio']),
		layer: z.enum(['high', 'med', 'low']).nullable()
	}),
	z.object({ kind: z.literal('bye') })
]);

export type Signal = z.infer<typeof signalSchema>;

/**
 * Which side yields when two offers collide.
 *
 * Perfect negotiation needs a total order over the two ends of a connection:
 * the polite peer rolls back its own offer and accepts the other, the impolite
 * peer ignores the incoming one. If both sides thought they were polite they
 * would both roll back and neither would connect; if both thought impolite,
 * both ignore and the connection stalls glared.
 *
 * Compared on ENDPOINT ids, never actor ids. Two tabs of one person share an
 * actor, so an actor comparison ties — and a tie is not merely inelegant, it
 * means both tabs answer the same offer with competing answers for a single
 * connection. Endpoints are per-tab and unique, so the order is total.
 */
export function isPolite(selfEndpoint: string, remoteEndpoint: string): boolean {
	return selfEndpoint < remoteEndpoint;
}
