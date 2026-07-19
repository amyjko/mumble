import type { Camera, Point, Size } from '$lib/model/types';
import { fitAll, screenToWorld, worldToScreen, zoomAt, unionBounds, type Bounds } from './geometry';

/**
 * Per-viewer camera (UX-CANVAS-2): a thin rune wrapper over geometry.ts.
 * Auto-zoom (UX-CANVAS-3) is on by default, disengages on any manual pan or
 * zoom, and re-engages only by explicit request. All math lives in
 * geometry.ts so it stays node-testable (AR-TEST-4).
 */
export class Viewport {
	camera = $state<Camera>({ x: 0, y: 0, scale: 1 });
	autoZoom = $state(true);
	size = $state<Size>({ width: 1, height: 1 });
	/** True briefly around programmatic fits so the world layer can animate
	 * them (and only them — user pan/zoom must stay 1:1). CSS reduced-motion
	 * neutralizes the animation itself. */
	animating = $state(false);
	private animationTimer: ReturnType<typeof setTimeout> | null = null;

	private markAnimated(): void {
		this.animating = true;
		if (this.animationTimer !== null) clearTimeout(this.animationTimer);
		this.animationTimer = setTimeout(() => {
			this.animating = false;
		}, 300);
	}

	toWorld(p: Point): Point {
		return screenToWorld(p, this.camera);
	}

	pan(dx: number, dy: number): void {
		this.autoZoom = false;
		this.camera = { ...this.camera, x: this.camera.x + dx, y: this.camera.y + dy };
	}

	zoomAtPoint(screenPoint: Point, factor: number): void {
		this.autoZoom = false;
		this.camera = zoomAt(this.camera, screenPoint, factor);
	}

	/**
	 * Back to 1:1 about the viewport centre (UX-CANVAS-3).
	 *
	 * Auto-fit is content-relative, so a room with one small note zooms in far
	 * enough that text is huge, and a sprawling one zooms out past readable.
	 * There was no way back to the size everything was DESIGNED at except
	 * nudging +/- until the readout said 100%.
	 *
	 * Disengages auto-fit, like every other manual camera move: leaving it on
	 * would let the next content change immediately undo the reset.
	 */
	resetZoom(): void {
		this.autoZoom = false;
		this.markAnimated();
		const centre = { x: this.size.width / 2, y: this.size.height / 2 };
		this.camera = zoomAt(this.camera, centre, 1 / this.camera.scale);
	}

	/** Recomputed on content change while autoZoom holds (UX-CANVAS-3). */
	fit(content: readonly Bounds[]): void {
		const union = unionBounds(content);
		const next =
			union === null
				? { x: this.size.width / 2, y: this.size.height / 2, scale: 1 }
				: fitAll(union, this.size);

		/*
		 * Nothing moved, so do not move — the same discipline `ensureVisible`
		 * already applies one method below.
		 *
		 * This runs on every content change, and with a server-backed store a
		 * content change now arrives on every peer broadcast: hydrating replaces
		 * the whole state, so the canvas recomputes bounds even when the fitted
		 * result is identical. Animating that made the world jitter continuously
		 * while anyone was typing — Playwright's "element is not stable" was
		 * literally true, and a click could not land on a moving button.
		 */
		if (next.x === this.camera.x && next.y === this.camera.y && next.scale === this.camera.scale) {
			return;
		}
		this.markAnimated();
		this.camera = next;
	}

	enableAutoZoom(content: readonly Bounds[]): void {
		this.autoZoom = true;
		this.fit(content);
	}

	/**
	 * Bring a world-space rect fully into view (UX-A11Y: tabbing to an
	 * off-screen object must reveal it). Pans minimally, keeping zoom — so it
	 * never fights auto-fit (when auto-fit is on, everything is already in
	 * view and this is a no-op) and never disorients with a scale change.
	 * Animated, so the reveal reads as movement.
	 */
	ensureVisible(bounds: Bounds, margin = 48): void {
		const tl = worldToScreen({ x: bounds.x, y: bounds.y }, this.camera);
		const br = worldToScreen(
			{ x: bounds.x + bounds.width, y: bounds.y + bounds.height },
			this.camera
		);
		let dx = 0;
		let dy = 0;
		if (tl.x < margin) dx = margin - tl.x;
		else if (br.x > this.size.width - margin) dx = this.size.width - margin - br.x;
		if (tl.y < margin) dy = margin - tl.y;
		else if (br.y > this.size.height - margin) dy = this.size.height - margin - br.y;
		if (dx === 0 && dy === 0) return;
		this.markAnimated();
		this.camera = { ...this.camera, x: this.camera.x + dx, y: this.camera.y + dy };
	}
}
