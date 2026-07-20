import type { MediaKind } from './transport';

/**
 * The camera and microphone (UX-AV-3, AR-CTRL-3).
 *
 * ABOVE the transport seam, deliberately. `transport.ts` says an implementation
 * is handed a track and never asks for one, because whether to prompt for a
 * camera is a product decision rather than a networking one — and the product
 * decision is that a lurker must never see a permission dialog. `planMedia`
 * returns IDLE for a lone occupant precisely so this is not called.
 *
 * It is nevertheless exempted from `no-provider-names.spec.ts` by path, and that
 * deserves saying out loud: the banned nouns are WebRTC mechanism, and the rule
 * is that no consumer of the transport may name a provider. Capture is not
 * transport — swapping an SFU in changes nothing here — so the exemption
 * narrows the rule to its intent rather than widening it.
 */

export interface Wanted {
	readonly video: boolean;
	readonly audio: boolean;
}

/**
 * Held so a track is acquired once and reused.
 *
 * Re-prompting on every plan change would flash the browser's permission
 * indicator and, worse, restart the camera — a visible flicker in everyone
 * else's tile every time an unrelated participant took a slot.
 */
export class Capture {
	private video: MediaStreamTrack | null = null;
	private audio: MediaStreamTrack | null = null;
	private disposed = false;
	/** Set once a prompt is refused, so we do not ask again on every plan. */
	private refused = false;

	get(kind: MediaKind): MediaStreamTrack | null {
		return kind === 'video' ? this.video : this.audio;
	}

	/** True when the person said no. The UI shows camera-off, not an error. */
	get denied(): boolean {
		return this.refused;
	}

	private isDisposed(): boolean {
		return this.disposed;
	}

	/**
	 * Acquire or release so that what is live matches `wanted`.
	 *
	 * Returns the kinds that CHANGED, so a caller can publish exactly what is
	 * new rather than republishing everything on every plan.
	 */
	async reconcile(wanted: Wanted): Promise<MediaKind[]> {
		if (this.isDisposed()) return [];
		const changed: MediaKind[] = [];

		// Release first: giving the camera back promptly is what turns the
		// hardware light off, and a person who has stopped publishing expects it
		// to go out.
		if (!wanted.video && this.video !== null) {
			this.video.stop();
			this.video = null;
			changed.push('video');
		}
		if (!wanted.audio && this.audio !== null) {
			this.audio.stop();
			this.audio = null;
			changed.push('audio');
		}

		const needVideo = wanted.video && this.video === null;
		const needAudio = wanted.audio && this.audio === null;
		if ((!needVideo && !needAudio) || this.refused) return changed;

		try {
			/*
			 * One prompt for both, not two. Asking separately shows the person two
			 * dialogs for one action, and a browser that has been granted the
			 * camera will usually grant the microphone in the same gesture.
			 */
			const stream = await navigator.mediaDevices.getUserMedia({
				video: needVideo,
				audio: needAudio
			});
			// Behind a method call, because a plain field read is narrowed to `false`
			// by the check at the top of this function — TypeScript cannot see that
			// an await gave `dispose()` a chance to run. It genuinely can: leaving
			// the room while the permission dialog is open lands exactly here, and
			// without this the camera stays on after the page is gone.
			if (this.isDisposed()) {
				for (const track of stream.getTracks()) track.stop();
				return changed;
			}
			const gotVideo = stream.getVideoTracks()[0] ?? null;
			const gotAudio = stream.getAudioTracks()[0] ?? null;
			if (needVideo && gotVideo !== null) {
				this.video = gotVideo;
				changed.push('video');
			}
			if (needAudio && gotAudio !== null) {
				this.audio = gotAudio;
				changed.push('audio');
			}
		} catch {
			/*
			 * A refusal is a state, not an error. UX-AV-3 has a camera-off
			 * appearance and this is one of the ways to arrive at it; throwing
			 * would take down a room over a permission the person is entitled to
			 * withhold.
			 */
			this.refused = true;
		}
		return changed;
	}

	dispose(): void {
		this.disposed = true;
		this.video?.stop();
		this.audio?.stop();
		this.video = null;
		this.audio = null;
	}
}
