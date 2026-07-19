import { describe, expect, it } from 'vitest';
import { flushSync } from 'svelte';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import HintBar from './HintBar.svelte';
import { hint, SNAP_HINT } from './hint.svelte';

/**
 * The gesture hint (UX-OBJ-13). Shift-to-snap was undiscoverable, so this bar
 * IS the feature — and it shipped with no test at all.
 */
describe('the gesture hint', () => {
	it('appears when a gesture shows it, and clears after', async () => {
		hint.clear();
		void render(HintBar);
		flushSync();
		await expect.element(page.getByText(SNAP_HINT)).not.toBeInTheDocument();

		hint.show(SNAP_HINT);
		flushSync();
		await expect.element(page.getByText(SNAP_HINT)).toBeInTheDocument();

		hint.clear();
		flushSync();
		await expect.element(page.getByText(SNAP_HINT)).not.toBeInTheDocument();
	});
});
