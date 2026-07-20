import type { PeerId } from './transport';

/**
 * Joining a screen share's picture and its sound into one stream (UX-OBJ-16).
 *
 * The transport delivers them as two independent tracks, arriving at different
 * moments. A `<video>` has ONE `srcObject`, so somewhere they have to become one
 * `MediaStream` — and doing it inline in a `$derived` is a trap worth spelling
 * out, because nothing would fail.
 *
 * `screenStreams` in Room.svelte derives from `remoteStreams`, which changes
 * whenever ANY peer's ANY track arrives or ends. A `new MediaStream([...])`
 * inside that derivation mints a fresh object on every recompute, so somebody
 * else joining and turning on their camera would hand the share's element a new
 * `srcObject`: playback restarts, the picture flickers, and the viewer's mute
 * choice resets. Every test would still pass.
 *
 * So identity is the contract. `combine` returns THE SAME `MediaStream` for the
 * same pair of inputs, and mints only when the inputs actually differ.
 *
 * The obvious shortcut — `existing.addTrack(audio)` — is rejected on three
 * counts: it depends on which track arrives first, it mutates an object the
 * transport owns, and live `addtrack` on a playing element is handled
 * inconsistently across browsers. Minting a new stream when the inputs change is
 * one re-attach at a moment something genuinely changed.
 */
interface Combined {
	readonly video: MediaStream;
	readonly audio: MediaStream | undefined;
	readonly merged: MediaStream;
}

export class StreamCombiner {
	// A plain Map, not a SvelteMap: this is a memo, not state. Nothing should
	// re-render because a cache entry was written.
	private readonly entries = new Map<PeerId, Combined>();

	/**
	 * One stream carrying both, stable across recomputes.
	 *
	 * `audio` undefined is the ordinary case — most shares carry no sound — and
	 * yields a video-only stream, which is exactly what a share without audio
	 * should render as.
	 */
	combine(peer: PeerId, video: MediaStream, audio: MediaStream | undefined): MediaStream {
		const existing = this.entries.get(peer);
		// Compared by REFERENCE, deliberately. Two MediaStreams carrying the same
		// tracks are still two objects to an element's `srcObject`, and the whole
		// point here is to hand back the identical one.
		if (existing !== undefined && existing.video === video && existing.audio === audio) {
			return existing.merged;
		}

		const tracks = [...video.getVideoTracks(), ...(audio?.getAudioTracks() ?? [])];
		const merged = new MediaStream(tracks);
		this.entries.set(peer, { video, audio, merged });
		return merged;
	}

	/** Drop one peer, so a rejoin starts clean rather than replaying a dead stream. */
	forget(peer: PeerId): void {
		this.entries.delete(peer);
	}

	clear(): void {
		this.entries.clear();
	}
}
