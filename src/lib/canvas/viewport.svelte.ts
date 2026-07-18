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

	/** Recomputed on content change while autoZoom holds (UX-CANVAS-3). */
	fit(content: readonly Bounds[]): void {
		this.markAnimated();
		const union = unionBounds(content);
		if (union === null) {
			this.camera = { x: this.size.width / 2, y: this.size.height / 2, scale: 1 };
			return;
		}
		this.camera = fitAll(union, this.size);
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
