import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { RESERVED_NAMES, roomNameProblem } from './room-name';

/**
 * The reserved list exists twice — in TypeScript for the UI's explanation, and
 * in SQL because AR-BACKEND-10 requires the rule to live in the schema rather
 * than in application code alone.
 *
 * Two copies of one list is a real risk, and the failure is silent in the worst
 * direction: a name the UI accepts and the database refuses is a room that
 * cannot be created for no visible reason, and the reverse is a name that
 * squats a future route. So they are compared.
 */
describe('the reserved-name list agrees across TypeScript and SQL', () => {
	const migration = readFileSync('supabase/migrations/20260719000001_rooms.sql', 'utf8');
	// `filter` rather than `!`: noUncheckedIndexedAccess makes the group
	// `string | undefined`, and the project bans non-null assertions.
	const seeded = [...migration.matchAll(/\('([a-z]+)'\)/g)]
		.map((m) => m[1])
		.filter((name): name is string => name !== undefined);

	it('seeds exactly the names the client refuses', () => {
		expect([...seeded].sort()).toEqual([...RESERVED_NAMES].sort());
	});

	it('and every seeded name is actually refused by the client rule', () => {
		// Guards the direction the set comparison cannot: that RESERVED_NAMES is
		// wired into roomNameProblem at all, rather than being an unused export.
		for (const name of seeded) {
			expect(roomNameProblem(name), name).toBe('reserved');
		}
	});
});
