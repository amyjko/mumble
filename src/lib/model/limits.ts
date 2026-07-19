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
