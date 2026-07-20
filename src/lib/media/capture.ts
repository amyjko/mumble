import type { MediaKind } from './transport';

/**
 * The capture sources: camera and microphone (UX-AV-3, AR-CTRL-3), and the
 * screen (UX-OBJ-6).
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

		/*
		 * Wanting nothing CLEARS the refusal.
		 *
		 * The latch stops us re-prompting on every plan, which would flash the
		 * permission dialog at somebody who has already said no. But it used to
		 * be permanent, so a person who refused, then went and granted the camera
		 * in their browser settings, stayed dark until they reloaded the page —
		 * and nothing told them a reload was what they needed.
		 *
		 * Releasing the slot is the one moment we know they are no longer trying,
		 * so it is the safe place to forget: turning the camera off and on again
		 * retries, which is exactly what anyone would try first.
		 */
		if (!wanted.video && !wanted.audio) this.refused = false;

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

/**
 * The screen (UX-OBJ-6).
 *
 * A SEPARATE class rather than a third field on `Capture`, because all three of
 * its differences from a camera are fatal to the reconcile model above:
 *
 *  1. **It needs a user gesture.** `Capture.reconcile` is reached from an
 *     `$effect`, through an `addPeer` loop and sometimes a grant fetch. User
 *     activation is long gone by then and `getDisplayMedia` simply throws. The
 *     call has to happen in the click handler, so acquisition here is IMPERATIVE
 *     while the camera's is declarative. `MediaSession` treats a screen slot as
 *     permission to publish rather than an instruction to acquire, and never
 *     calls `start()` itself.
 *
 *  2. **It is a picker, not a permission.** `Capture.refused` exists to stop
 *     re-prompting on every plan; nothing ever auto-asks for a screen, so there
 *     is nothing to latch. Worse, latching would be wrong: cancelling the picker
 *     is "I changed my mind", and the very next click must open it again.
 *
 *  3. **The browser can end it.** The "Stop sharing" bar kills the track with no
 *     state change anywhere, so a reconcile loop cannot notice — it only runs
 *     when its inputs change, and nothing changed. That needs an event edge,
 *     which is what `onEnded` is.
 *
 * It holds TWO tracks (UX-OBJ-16): the picture, and the share's own sound. The
 * sound is optional in the strongest sense — Chrome puts a "share tab audio"
 * checkbox in its own picker, Firefox offers it only on some paths and Safari
 * not at all, so ABSENT IS THE NORMAL CASE and never an error.
 *
 * The lifecycle rule that matters: **the share IS the video track.** Video
 * ending ends the share and stops the audio with it. Audio ending alone ends
 * only the audio — attaching one handler to both is the naive version, and it
 * tears down a live share the moment somebody switches which tab they share.
 */
export class ScreenCapture {
	private track: MediaStreamTrack | null = null;
	private audio: MediaStreamTrack | null = null;
	private disposed = false;
	private readonly handlers = new Set<() => void>();
	private readonly audioHandlers = new Set<() => void>();

	// Behind a method for the same reason `Capture` needs one: a plain field read
	// is narrowed to `false` by the check at the top of `start()`, and TypeScript
	// cannot see that an await gave `dispose()` a chance to run. It genuinely can.
	private isDisposed(): boolean {
		return this.disposed;
	}

	/** The PICTURE. Deliberately still the thing `current` means. */
	get current(): MediaStreamTrack | null {
		return this.track;
	}

	/** The share's own sound, or null — which is the common case. */
	get currentAudio(): MediaStreamTrack | null {
		return this.audio;
	}

	/**
	 * Open the picker. MUST be called directly from a user gesture — await
	 * nothing before it, or the browser will refuse for want of activation.
	 *
	 * `null` means they cancelled, which is an ordinary answer and not an error:
	 * no latch, no state, and the next call asks again.
	 */
	async start(): Promise<MediaStreamTrack | null> {
		if (this.disposed) return null;
		// Already sharing: hand back what we hold rather than opening a second
		// picker over the top of the first.
		if (this.track !== null) return this.track;

		try {
			/*
			 * Audio is REQUESTED, never demanded. Chrome's picker owns the "share
			 * tab audio" checkbox, so asking is how the checkbox appears at all —
			 * and an unchecked box is an ordinary answer.
			 *
			 * No audio CONSTRAINTS, deliberately. Display capture arrives with echo
			 * cancellation, gain control and noise suppression off, which is exactly
			 * right for music; asking for anything turns the voice DSP back on and
			 * mangles it.
			 */
			const stream = await navigator.mediaDevices.getDisplayMedia({
				video: true,
				audio: true
			});
			const track = stream.getVideoTracks()[0] ?? null;
			// Stop EVERYTHING before bailing. Returning on a missing video track
			// while an audio track from the same stream is live would leave the
			// browser capturing sound for a share that does not exist.
			if (track === null) {
				for (const each of stream.getTracks()) each.stop();
				return null;
			}

			// Leaving the room while the picker is open lands exactly here. Without
			// this the share stays live after the page is gone — the same hazard
			// `Capture.reconcile` guards, arriving by a different route.
			if (this.isDisposed()) {
				for (const each of stream.getTracks()) each.stop();
				return null;
			}

			// A W3C hint, not a provider noun: tells the encoder this is text and
			// diagrams rather than a face, which is the cheapest single lever on
			// legibility. The rung it gets is decided in `encode.ts`.
			track.contentHint = 'detail';

			// The person clicking "Stop sharing" in the browser's own bar is the
			// most likely way a share ends, and nothing else can observe it.
			track.onended = () => {
				// The share IS the picture: its end takes the sound with it.
				this.releaseAudio();
				this.track = null;
				for (const handler of this.handlers) handler();
			};

			const audio = stream.getAudioTracks()[0] ?? null;
			if (audio !== null) {
				/*
				 * A SEPARATE handler, and it must never call `this.handlers`.
				 *
				 * Tab audio can stop on its own — switching which tab is shared, or
				 * the source simply going silent-by-revocation — and firing the share
				 * handlers here would tear down a perfectly live picture.
				 */
				audio.onended = () => {
					this.audio = null;
					for (const handler of this.audioHandlers) handler();
				};
				this.audio = audio;
			}

			this.track = track;
			return track;
		} catch {
			// A cancelled picker throws. It is a decision, not a failure, and it
			// leaves NO trace — see the note on latching above.
			return null;
		}
	}

	/** Give the sound back without touching the picture. */
	private releaseAudio(): void {
		const audio = this.audio;
		if (audio === null) return;
		this.audio = null;
		audio.onended = null;
		audio.stop();
	}

	stop(): void {
		// Sound first, and unconditionally: a share whose audio outlived its
		// picture would keep the browser's capture indicator up for nothing.
		this.releaseAudio();
		const track = this.track;
		if (track === null) return;
		this.track = null;
		// Cleared first: `stop()` does not fire `onended`, but clearing before the
		// call means a handler that somehow does run sees the truth.
		track.onended = null;
		track.stop();
	}

	/** Told when the BROWSER ended the share. Returns an unsubscriber. */
	onEnded(handler: () => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	/**
	 * Told when the share's SOUND ended on its own, the picture surviving.
	 *
	 * Separate from `onEnded` because the consequences are different: this
	 * unpublishes one track, that ends the whole share. Nothing in room state
	 * changes either way, so both need an event edge.
	 */
	onAudioEnded(handler: () => void): () => void {
		this.audioHandlers.add(handler);
		return () => this.audioHandlers.delete(handler);
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
		this.handlers.clear();
		this.audioHandlers.clear();
	}
}
