/**
 * The canvas background (UX-CANVAS-5) is shared room state and, eventually, any
 * CSS background. A user-supplied CSS value is an injection surface, so the
 * stub accepts only a conservative subset — colors, gradients, and design
 * tokens — and rejects anything that could pull a network resource or smuggle
 * extra declarations. Full image/url support is deferred with this guard in
 * place. Pure and node-tested (the rejection cases ARE the mutation test).
 */

const FORBIDDEN = /url\(|image-set\(|expression|javascript:|[;{}<>@\\]/i;
const ALLOWED = /^[a-z0-9\s,.%#()/*_-]*$/i;

export function isSafeBackground(value: string): boolean {
	if (value.length > 400) return false;
	if (FORBIDDEN.test(value)) return false;
	return ALLOWED.test(value);
}

/**
 * Room brightness, replacing the old named presets.
 *
 * "Paper / Slate / Dawn / Spotlight" named nothing a user could reason about —
 * they were near-identical shades in one theme and meaningless across the
 * two, and being gradients they could not even be ranked. Brightness is a
 * single ordered dimension that means the same thing in both themes: level 5
 * is brighter than level 1 either way, even though the light ramp walks toward
 * white and the dark ramp walks up from near-black.
 *
 * The values are tokens, so they stay theme-aware and raw-color-free, and each
 * level's contrast against --text and --focus-ring is asserted in
 * theme-contrast.spec.ts. Arbitrary user-chosen background colors are
 * deliberately NOT offered: nothing could guarantee text stayed legible on one.
 */
export const BACKGROUND_LEVELS: { name: string; value: string }[] = [
	{ name: 'Room default', value: '' },
	{ name: 'Brightness 1, dimmest', value: 'var(--bg-level-1)' },
	{ name: 'Brightness 2', value: 'var(--bg-level-2)' },
	{ name: 'Brightness 3', value: 'var(--bg-level-3)' },
	{ name: 'Brightness 4', value: 'var(--bg-level-4)' },
	{ name: 'Brightness 5, brightest', value: 'var(--bg-level-5)' }
];
