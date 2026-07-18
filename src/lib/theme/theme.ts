/**
 * Theme selection (AR-STYLE-2, UX-A11Y-4): 'system' follows the OS via
 * color-scheme; explicit choices set data-theme on <html>. Persisted per
 * browser, applied pre-paint by app.html's inline script; this module is the
 * runtime side of the same contract. Local-only state — never synced.
 */

export type Theme = 'system' | 'light' | 'dark';

const KEY = 'mumble:theme';
const ORDER: readonly Theme[] = ['system', 'light', 'dark'];

export function getTheme(): Theme {
	// SSR-safe: the layout renders server-side on SSR routes; the pre-paint
	// script in app.html has already applied the stored theme by the time this
	// hydrates, so 'system' here is only ever a transient default.
	if (typeof localStorage === 'undefined') return 'system';
	const stored = localStorage.getItem(KEY);
	return stored === 'light' || stored === 'dark' ? stored : 'system';
}

export function applyTheme(theme: Theme): void {
	if (theme === 'system') {
		delete document.documentElement.dataset['theme'];
		localStorage.removeItem(KEY);
	} else {
		document.documentElement.dataset['theme'] = theme;
		localStorage.setItem(KEY, theme);
	}
}

export function nextTheme(current: Theme): Theme {
	const index = ORDER.indexOf(current);
	return ORDER[(index + 1) % ORDER.length] ?? 'system';
}

export const THEME_LABEL: Record<Theme, string> = {
	system: 'System theme',
	light: 'Light theme',
	dark: 'Dark theme'
};

export const THEME_ICON: Record<Theme, string> = {
	system: '◐',
	light: '☀',
	dark: '☾'
};
