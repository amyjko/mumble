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

/** Named presets, built from tokens so they stay theme-aware and raw-color-free. */
export const BACKGROUND_PRESETS: { name: string; value: string }[] = [
	{ name: 'Default', value: '' },
	{ name: 'Paper', value: 'var(--surface)' },
	{ name: 'Slate', value: 'var(--surface-2)' },
	{ name: 'Dawn', value: 'linear-gradient(160deg, var(--surface), var(--surface-2))' },
	{ name: 'Spotlight', value: 'radial-gradient(circle at 50% 30%, var(--surface), var(--bg-canvas))' }
];
