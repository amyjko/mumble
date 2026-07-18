/**
 * User-selectable color DATA — draw-stroke colors and their default. These are
 * values a user picks and that get stored in object payloads, NOT component
 * styling, so they live in one audited module rather than as scattered
 * literals. This file is the single exemption from no-raw-color (see
 * no-raw-color.spec.ts); component styling still goes through tokens.
 *
 * Each swatch carries a NAME because color alone cannot be the only way to
 * tell the options apart (WCAG 1.4.1) — the name is the swatch's accessible
 * name in SwatchPicker. The list previously had no names and, in practice, was
 * never imported at all: the UI shipped a native <input type="color">, so the
 * curated palette existed only on paper.
 */
export interface Swatch {
	name: string;
	value: string;
}

export const DRAW_COLORS: readonly Swatch[] = [
	{ name: 'Red', value: '#e11d48' },
	{ name: 'Blue', value: '#2563eb' },
	{ name: 'Green', value: '#16a34a' },
	{ name: 'Amber', value: '#ca8a04' },
	{ name: 'Violet', value: '#7c3aed' },
	{ name: 'Cyan', value: '#0891b2' },
	{ name: 'Ink', value: '#1c1917' },
	{ name: 'Chalk', value: '#fafaf9' }
];

export const DEFAULT_DRAW_COLOR = '#e11d48';
