/**
 * Storage-shaped limits the rules have to honour.
 *
 * CHAT_LOG_LIMIT is a STUB CONCESSION, not a product rule: UX-OBJ-3 says chat
 * is "retained", and the cap exists because localStorage is finite. It lives
 * here rather than in the store because the rule engine enforces it and the
 * engine may not import a store — but it should DIE when chat messages become
 * their own table, at which point appending is one row and nothing needs a cap.
 * The count of evicted messages is surfaced to the user (Room.svelte) rather
 * than dropped silently.
 */
export const CHAT_LOG_LIMIT = 500;

/**
 * The object-count budget for one room (AR-CANVAS-4).
 *
 * The requirement scopes DOM-on-a-transformed-canvas to "tens to low-hundreds
 * of objects, several live videos" and asks for the ceiling to be **defined and
 * measured** rather than assumed. This is that number, and these are the
 * measurements it came from.
 *
 * Measured 2026-07-20 by `e2e/canvas-budget.e2e.ts` — a real room in workerd,
 * every object mounted, one dragged while frame intervals are recorded:
 *
 * ```
 *     25 objects: median  8.3ms, p95  9.8ms, load  435ms
 *    100 objects: median  8.1ms, p95 10.4ms, load  306ms
 *    200 objects: median  8.5ms, p95 11.4ms, load  365ms
 *    400 objects: median 11.0ms, p95 15.1ms, load  577ms   <- the budget
 *    800 objects: median  6.9ms, p95 25.4ms, load  839ms
 *   1600 objects: median  4.5ms, p95 48.7ms, load 1747ms
 * ```
 *
 * **Read the p95 column, not the median.** The median IMPROVES past 800 while
 * the experience collapses, which is the trap in measuring this by average: most
 * frames stay cheap and a few become catastrophic, so the mean of a janky room
 * looks like a smooth one. At 400 the p95 is still inside a single 60Hz frame
 * (16.7ms). At 800 it is a frame and a half — visible stutter under the pointer.
 * At 1600 it is 49ms, roughly 20fps while dragging.
 *
 * 400 is therefore where the ceiling actually is, not where it was guessed. It
 * is also comfortably past any room anyone has built: the largest real layout in
 * the test suite is under thirty objects.
 *
 * TWO THINGS THIS DOES NOT PROVE. The requirement says "on target devices", and
 * the only device measured is a development machine — a phone will find the knee
 * earlier, and nothing here knows where. And these are notes: cheap, static
 * rectangles. Drawings with long point lists and live video tiles are the
 * "drawing-complexity" half of the same requirement, still unmeasured.
 *
 * It is a BUDGET, not an enforced cap. Nothing refuses the 401st object,
 * deliberately: the failure past this line is gradual, and a hard limit would
 * turn a performance observation into a rule that tells someone they may not put
 * down another note. The number exists so a regression has something to fail
 * against, and so virtualization — which the requirement names as the response
 * past the ceiling — has a trigger rather than a hunch.
 */
export const MAX_ROOM_OBJECTS = 400;
