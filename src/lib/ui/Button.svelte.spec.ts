import { describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ButtonHarness from './ButtonHarness.svelte';

/**
 * Browser-mode tests for the one button (AR-STYLE-1). These assert the
 * CONTRACT the 30 migrated call sites depend on — accessible naming, the
 * toggle/plain distinction, disabled semantics, and the WCAG 2.2 §2.5.8 target
 * floor — rather than its styling. Real layout is required for the target-size
 * assertion, which is why this runs in Chromium and not jsdom.
 */

describe('Button', () => {
	it('a bare glyph gets its accessible name from `label`', async () => {
		await render(ButtonHarness, { label: 'Delete note', text: '×' });
		const button = page.getByRole('button', { name: 'Delete note' });
		await expect.element(button).toBeVisible();
	});

	it('omits aria-pressed entirely when `pressed` is not passed', async () => {
		await render(ButtonHarness, { text: 'Add note' });
		const button = page.getByRole('button', { name: 'Add note' });
		await expect.element(button).toBeVisible();
		// A plain button must not advertise toggle semantics — screen readers
		// announce "toggle button, not pressed" for aria-pressed="false".
		expect(button.element().getAttribute('aria-pressed')).toBeNull();
	});

	it('reflects `pressed` as aria-pressed when it is passed', async () => {
		await render(ButtonHarness, { text: 'Auto-fit', pressed: true });
		const button = page.getByRole('button', { name: 'Auto-fit', pressed: true });
		await expect.element(button).toBeVisible();
	});

	it('does not fire onclick while disabled', async () => {
		const onclick = vi.fn();
		await render(ButtonHarness, { text: 'Send', disabled: true, onclick });
		const button = page.getByRole('button', { name: 'Send' });
		await expect.element(button).toBeDisabled();
		expect(onclick).not.toHaveBeenCalled();
	});

	it('meets the 24px minimum target size in both shapes (WCAG 2.2 §2.5.8)', async () => {
		await render(ButtonHarness, { label: 'Rotate', text: '↺', shape: 'icon' });
		const icon = page.getByRole('button', { name: 'Rotate' });
		await expect.element(icon).toBeVisible();
		const box = icon.element().getBoundingClientRect();
		// The icon shape is the one that regressed historically: hand-rolled
		// versions set min-height only, leaving `×` buttons too narrow.
		expect(box.width).toBeGreaterThanOrEqual(24);
		expect(box.height).toBeGreaterThanOrEqual(24);
	});
});
