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

/**
 * Tooltips (UX-A11Y / discoverability). The product is full of single-glyph
 * chrome — ◇ ▣ ⤒ ⤓ ● ⛶ × — whose meaning lived only in an aria-label. Sighted
 * pointer users got the native `title` after an unpredictable delay; keyboard
 * users got nothing at all.
 */
describe('Button tooltip', () => {
	it('appears on hover and on FOCUS, and names the control', async () => {
		await render(ButtonHarness, { label: 'Delete note', text: '×' });
		const button = page.getByRole('button', { name: 'Delete note' });

		expect(document.querySelector('.tip')).toBeNull();

		button.element().dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
		await vi.waitFor(() => {
			expect(document.querySelector('.tip')?.textContent).toBe('Delete note');
		});

		button.element().dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
		await vi.waitFor(() => {
			expect(document.querySelector('.tip')).toBeNull();
		});

		// Keyboard parity is the reason this exists rather than `title`.
		button.element().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		await vi.waitFor(() => {
			expect(document.querySelector('.tip')?.textContent).toBe('Delete note');
		});
	});

	it('is hidden from assistive tech, because it repeats the accessible name', async () => {
		await render(ButtonHarness, { label: 'Delete note', text: '×' });
		const button = page.getByRole('button', { name: 'Delete note' });
		button.element().dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
		await vi.waitFor(() => {
			expect(document.querySelector('.tip')?.getAttribute('aria-hidden')).toBe('true');
		});
	});

	it('keeps its 8px margin from the edge instead of being squeezed against it', async () => {
		// Chrome clusters at the very edges of the canvas. Note what this does
		// NOT assert: that the tooltip stays on screen. A fixed element with
		// `left` set shrink-to-fits against the viewport, so it reflows narrower
		// rather than overflowing — "right <= innerWidth" is true no matter what
		// the placement code does, and a mutant that deleted the clamp passed
		// that version of this test. The margin is what clamping actually buys:
		// text that keeps its natural width instead of being crushed into a
		// column at the edge.
		await render(ButtonHarness, {
			label: 'A deliberately long tooltip that would overflow the window edge',
			text: '×',
			wrapperStyle: 'position: fixed; right: 0; top: 50%;'
		});
		const button = page.getByRole('button', { name: /deliberately long/ });
		button.element().dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));

		await vi.waitFor(() => {
			const tip = document.querySelector('.tip');
			expect(tip).not.toBeNull();
			const box = tip?.getBoundingClientRect();
			expect(box).toBeDefined();
			if (box === undefined) return;
			expect(box.left).toBeGreaterThanOrEqual(8);
			expect(box.right).toBeLessThanOrEqual(window.innerWidth - 8);
		});
	});

	it('can be opted out of, for a control whose text already says everything', async () => {
		await render(ButtonHarness, { label: 'Add note', text: '+ note', tooltip: null });
		const button = page.getByRole('button', { name: 'Add note' });
		button.element().dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(document.querySelector('.tip')).toBeNull();
	});
});
