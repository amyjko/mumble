/**
 * AR-DEPLOY-3: the Workers ceiling is a budget constraint, tracked in CI.
 *
 * The free tier allows a 3 MB compressed worker script. Measured 2026-07-16 at
 * 234 KiB gzipped — 7.6% of the cap — which is exactly why this check exists:
 * the requirement's point is to KEEP it a non-issue, so a regression fails the
 * build instead of being noticed months later when the deploy stops working.
 *
 * The threshold is deliberately a ceiling well under the real cap, not a
 * hair's breadth above today's size: a check that fails on every ordinary
 * change gets disabled, and a disabled check protects nothing.
 *
 * Usage: node scripts/check-bundle.mjs [--limit-kib N]
 */
import { execFileSync } from 'node:child_process';

const DEFAULT_LIMIT_KIB = 600;
const WORKERS_CAP_KIB = 3 * 1024;

/**
 * JSDoc types, not bare params: this file has no tsconfig project, so without
 * them every argv access is `any` and trips the no-unsafe-* rules. The norms
 * apply to build scripts too.
 *
 * @param {string[]} argv
 * @returns {number}
 */
function parseLimit(argv) {
	const at = argv.indexOf('--limit-kib');
	if (at === -1) return DEFAULT_LIMIT_KIB;
	const raw = argv[at + 1];
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		console.error(`check-bundle: --limit-kib needs a positive number, got ${String(raw)}`);
		process.exit(2);
	}
	return value;
}

const limitKiB = parseLimit(process.argv.slice(2));

let output;
try {
	// --dry-run does not deploy and needs no credentials, which is what makes
	// this runnable on a pull request from a fork.
	output = execFileSync('npx', ['wrangler', 'deploy', '--dry-run'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }
	});
} catch (error) {
	console.error('check-bundle: `wrangler deploy --dry-run` failed.');
	if (error instanceof Error && 'stderr' in error) console.error(String(error.stderr));
	process.exit(1);
}

// e.g. "Total Upload: 1188.90 KiB / gzip: 234.65 KiB"
const match = /gzip:\s*([\d.]+)\s*KiB/i.exec(output);
if (match === null) {
	console.error('check-bundle: could not find a gzip size in wrangler output.');
	console.error('This usually means wrangler changed its output format — fix the');
	console.error('parser rather than deleting the check.\n');
	console.error(output);
	process.exit(1);
}

const gzipKiB = Number(match[1]);
const percentOfCap = ((gzipKiB / WORKERS_CAP_KIB) * 100).toFixed(1);

if (gzipKiB > limitKiB) {
	console.error(
		`check-bundle: FAIL — worker is ${String(gzipKiB)} KiB gzipped, over the ${String(limitKiB)} KiB budget ` +
			`(${percentOfCap}% of the 3 MB Workers cap).`
	);
	console.error('Either the growth is justified and the budget moves deliberately,');
	console.error('or something large was imported into the server bundle by accident.');
	process.exit(1);
}

console.log(
	`check-bundle: OK — ${String(gzipKiB)} KiB gzipped, ${percentOfCap}% of the 3 MB cap ` +
		`(budget ${String(limitKiB)} KiB).`
);
