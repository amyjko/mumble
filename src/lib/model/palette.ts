/**
 * User-selectable color DATA — draw-stroke colors and their default. These are
 * values a user picks and that get stored in object payloads, NOT component
 * styling, so they live in one audited module rather than as scattered
 * literals. This file is the single exemption from no-raw-color (see
 * no-raw-color.spec.ts); component styling still goes through tokens.
 */
export const DRAW_COLORS: readonly string[] = [
	'#e11d48',
	'#2563eb',
	'#16a34a',
	'#ca8a04',
	'#7c3aed',
	'#0891b2',
	'#1c1917',
	'#fafaf9'
];

export const DEFAULT_DRAW_COLOR = '#e11d48';
