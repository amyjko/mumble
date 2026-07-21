import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
 *
 * This used to read ONE migration by name. It cannot any more: the list is
 * seeded across migrations (the original fifteen in `20260719000001_rooms.sql`,
 * the root-namespace widening in `20260721000001_reserve_root_names.sql`), and
 * it will be added to again. So every migration is scanned, and the union is
 * what has to match — which is also what Postgres actually ends up holding.
 */
describe('the reserved-name list agrees across TypeScript and SQL', () => {
	const dir = 'supabase/migrations';

	/**
	 * Names seeded into `reserved_room_names` by any migration.
	 *
	 * Scoped to the INSERT rather than swept from the whole file: migrations are
	 * full of unrelated parenthesised literals — role names, check constraints,
	 * enum members — and a loose sweep would quietly pull them in and then
	 * demand they be reserved. Comments are stripped first, so a name mentioned
	 * in prose (or an example that was commented OUT) cannot count as seeded.
	 */
	const seeded = readdirSync(dir)
		.filter((file) => file.endsWith('.sql'))
		.flatMap((file) => {
			const sql = readFileSync(join(dir, file), 'utf8').replace(/--[^\n]*/g, '');
			return [...sql.matchAll(/insert\s+into\s+reserved_room_names\b[^;]*;/gi)].flatMap(
				(statement) =>
					[...statement[0].matchAll(/\('([a-z0-9_-]+)'\)/g)]
						// `filter` rather than `!`: noUncheckedIndexedAccess makes the
						// group `string | undefined`, and the project bans non-null
						// assertions.
						.map((m) => m[1])
						.filter((name): name is string => name !== undefined)
			);
		});

	it('seeds exactly the names the client refuses', () => {
		// A Set on the SQL side because a name may legitimately be seeded twice:
		// the widening migration re-lists the original fifteen under `on conflict
		// do nothing` so it can stand alone as the full picture.
		expect([...new Set(seeded)].sort()).toEqual([...RESERVED_NAMES].sort());
	});

	it('and every seeded name is actually refused by the client rule', () => {
		// Guards the direction the set comparison cannot: that RESERVED_NAMES is
		// wired into roomNameProblem at all, rather than being an unused export.
		for (const name of seeded) {
			expect(roomNameProblem(name), name).toBe('reserved');
		}
	});

	it('reserves every top-level route the app actually has', () => {
		// The set comparison above proves the two COPIES agree; it cannot notice
		// that both are missing a route. This can. A route directory that is not
		// reserved is a name someone can claim today and a collision the moment
		// we want that path back.
		const routes = readdirSync('src/routes', { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith('['))
			.map((entry) => entry.name);
		for (const route of routes) {
			expect(RESERVED_NAMES, route).toContain(route);
		}
	});
});
