/**
 * WCAG 2.x relative luminance and contrast ratio, per
 * https://www.w3.org/TR/WCAG22/#dfn-relative-luminance — pure math, reused by
 * theme-contrast.spec.ts and available to any future runtime check (e.g.
 * validating a host-picked canvas background against UX-CANVAS-5).
 */

/** Parse #rgb, #rrggbb, or #rrggbbaa (alpha ignored) to [r,g,b] in 0..255. */
export function parseHex(hex: string): [number, number, number] | null {
	const h = hex.replace(/^#/, '');
	if (h.length === 3) {
		const r = h[0];
		const g = h[1];
		const b = h[2];
		if (r === undefined || g === undefined || b === undefined) return null;
		return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)];
	}
	if (h.length === 6 || h.length === 8) {
		return [
			parseInt(h.slice(0, 2), 16),
			parseInt(h.slice(2, 4), 16),
			parseInt(h.slice(4, 6), 16)
		];
	}
	return null;
}

function channel(c255: number): number {
	const c = c255 / 255;
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(rgb: [number, number, number]): number {
	const [r, g, b] = rgb;
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two hex colors, 1..21. Returns null on parse failure. */
export function contrastRatio(hexA: string, hexB: string): number | null {
	const a = parseHex(hexA);
	const b = parseHex(hexB);
	if (a === null || b === null) return null;
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}
