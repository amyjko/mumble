/**
 * The modifier hint shown at the bottom of the screen during a gesture.
 *
 * Shift-to-snap was undiscoverable: nothing anywhere said it existed. A hint
 * that appears exactly while you are dragging, resizing, or rotating teaches
 * it at the only moment it is useful.
 *
 * Deliberately NOT an aria-live region. It would fire on every gesture start
 * and machine-gun a screen reader with something that is purely a pointer
 * affordance; the keyboard equivalents are documented in STYLE.md §5, and the
 * page's existing polite region stays the sole announcer.
 */
class HintState {
	current = $state<string | null>(null);

	show(message: string): void {
		this.current = message;
	}

	clear(): void {
		this.current = null;
	}
}

export const hint = new HintState();

/** The one gesture hint we have, so its wording stays consistent. */
export const SNAP_HINT = 'Hold Shift to snap';
