import { describe, expect, it } from 'vitest';
import { offendingLines, sourceFiles } from '$lib/test/source-scan';

/**
 * Postgres Changes is never used (AR-BACKEND-3).
 *
 * The requirement calls itself "a standing guardrail", and until now it was
 * only a sentence — its tag said "trivially honoured; nothing enforces it",
 * which is the same shape as `permission` shipping fully implemented and
 * unreachable: a rule nobody checks is a rule that holds until the first person
 * in a hurry.
 *
 * And this one is exactly the rule a person in a hurry breaks. Postgres Changes
 * is the OBVIOUS Supabase API for "tell me when a row changed" — it is in every
 * tutorial, it is one method call, and it would appear to work perfectly in a
 * two-person test room. What it cannot do is carry drag rates: it is
 * single-threaded to preserve ordering, with a throughput ceiling around 64
 * changes/sec, which is orders of magnitude below the ~15–20 Hz per dragger
 * that AR-BACKEND-5 already budgets for. The failure would arrive as
 * unexplained lag under load, long after the commit that caused it, in a
 * feature that tested fine.
 *
 * Broadcast is the sanctioned path for every class of shared traffic
 * (AR-BACKEND-2), and the store seam already speaks it.
 */

/**
 * The channel API's own vocabulary for the feature.
 *
 * `postgres_changes` is the event name passed to `channel.on(...)`, and
 * `REALTIME_LISTEN_TYPES.POSTGRES_CHANGES` is the enum spelling of the same
 * thing — both are matched, because banning only the string would let the
 * typed constant through and the typed constant is what an editor suggests.
 *
 * Deliberately NOT matched: `realtime.broadcast_changes`, the DATABASE function
 * AR-BACKEND-4 wants for fan-out. It contains the word "changes" and is the
 * approved mechanism, so a looser pattern would ban the thing the architecture
 * is heading toward.
 */
const POSTGRES_CHANGES = /\bpostgres_changes\b|\bPOSTGRES_CHANGES\b/;

describe('Postgres Changes is never used for sync (AR-BACKEND-3)', () => {
	const files = sourceFiles({
		// This file names it in order to ban it.
		exempt: (relative) => relative === 'lib/store/no-postgres-changes.spec.ts'
	});

	it('finds source files to check', () => {
		// A path change that silently emptied this list would make the assertion
		// below vacuously true — the failure mode this project has been bitten by
		// more than once, and the reason every guardrail here asserts its own
		// input first.
		expect(files.length).toBeGreaterThan(50);
	});

	it.each(files.map((f) => [f.relative, f] as const))('%s does not subscribe to row changes', (_relative, file) => {
		expect(offendingLines(file, POSTGRES_CHANGES)).toEqual([]);
	});

	it('the pattern actually matches what it claims to', () => {
		// The guard on the guard. A scanner with a wrong regex passes silently and
		// proves nothing, which is worse than no scanner because it reads as
		// evidence. Both spellings are checked against the pattern directly.
		expect(POSTGRES_CHANGES.test(".on('postgres_changes', { event: '*' }, handler)")).toBe(true);
		expect(POSTGRES_CHANGES.test('REALTIME_LISTEN_TYPES.POSTGRES_CHANGES')).toBe(true);
		// ...and does not catch the approved fan-out mechanism (AR-BACKEND-4).
		expect(POSTGRES_CHANGES.test("realtime.broadcast_changes('topic')")).toBe(false);
		expect(POSTGRES_CHANGES.test(".on('broadcast', { event: 'delta' }, handler)")).toBe(false);
	});
});
