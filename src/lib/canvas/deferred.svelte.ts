/**
 * A commit that waits for the gesture to stop (UX-A11Y-2).
 *
 * Holding an arrow key must produce ONE mutation, not fifty, so the keyboard
 * move commits on a trailing debounce. ObjectFrame and AvatarTile each had
 * their own copy of that — same delay, same re-arm, same trailing call — which
 * is the shape this codebase keeps paying for: near-identical copies where a
 * correction has to be applied twice and the second is missed.
 *
 * It also tracks how much deferred work is OUTSTANDING, which is the reason
 * this is a module rather than a local helper. A test waiting for a write to
 * land needs to know that a commit is coming but has not been issued yet: the
 * store's in-flight count is still zero during the debounce window, so a test
 * that only watched that would sail past and assert against state the server
 * has never seen. Two E2E tests approximated the window with a fixed
 * `waitForTimeout(400)`, which is a fair bet against localStorage and a coin
 * toss against a network — and a lost toss writes the wrong value, so it fails
 * permanently rather than slowly.
 */

let outstanding = $state(0);

/** How many commits are scheduled but not yet issued. Reactive. */
export const deferredWork = {
	get outstanding(): number {
		return outstanding;
	}
};

export interface DeferredCommit {
	/** (Re)arm the trailing timer. Re-arming does not double-count. */
	schedule: (run: () => void) => void;
	/** Drop a pending commit without running it. */
	cancel: () => void;
}

/** Trailing debounce. 250ms is what both copies used. */
export function createDeferredCommit(delayMs = 250): DeferredCommit {
	let timer: ReturnType<typeof setTimeout> | null = null;

	function release(): void {
		if (timer === null) return;
		clearTimeout(timer);
		timer = null;
		outstanding -= 1;
	}

	return {
		schedule(run: () => void): void {
			// Counted once per armed timer, not once per keystroke: re-arming
			// clears the old timer, so incrementing again would leak the count and
			// leave `outstanding` permanently above zero.
			if (timer !== null) clearTimeout(timer);
			else outstanding += 1;

			timer = setTimeout(() => {
				timer = null;
				outstanding -= 1;
				run();
			}, delayMs);
		},
		cancel(): void {
			release();
		}
	};
}
