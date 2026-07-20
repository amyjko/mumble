import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No consumer of the transport adapter may name a provider (AR-TRANSPORT-10).
 *
 * Sibling of no-raw-color.spec.ts and no-raw-emoji.spec.ts, and for the same
 * reason those exist: the requirement states a rule that nobody can hold in
 * their head across a growing surface, and a rule that is only a sentence gets
 * broken by the first person in a hurry.
 *
 * The rule, verbatim: "Provider identifiers, SDKs, and vendor-shaped concepts
 * live inside an implementation and nowhere else — that constraint is what
 * AR-TRANSPORT-3 means operationally and what makes 'swap the SFU' a contained
 * change instead of an audit."
 *
 * The payoff is specifically the V2 SFU. Every WebRTC noun that escapes
 * `media/p2p/` is a place the SFU would have to be retrofitted, and the whole
 * point of writing the seam before its first implementation was to stop that
 * happening by accident. This test is what makes "before" stay true afterwards.
 */

const SRC = new URL('../..', import.meta.url).pathname;

/**
 * WebRTC and vendor nouns. These are P2P mechanism, not media vocabulary: the
 * seam speaks peers, kinds, layers and stats, and nothing above it should need
 * to know that SDP exists.
 *
 * `MediaStream` and `MediaStreamTrack` are deliberately ABSENT. They are W3C
 * media types that the interface itself passes and a tile renders — naming them
 * is not naming a transport, and banning them would push the ban into absurdity.
 */
const PROVIDER_NOUNS =
	/\bRTCPeerConnection\b|\bRTCSessionDescription\b|\bRTCIceCandidate\b|\bRTCRtpSender\b|\bRTCRtpReceiver\b|\bRTCRtpTransceiver\b|\bgetUserMedia\b|\bgetDisplayMedia\b|\biceServers\b|\bsimulcast\b|\bturn:|\bstun:/i;

/** The one place WebRTC is allowed to exist, plus the seam's own prose. */
function isExempt(relative: string): boolean {
	return (
		relative.startsWith('lib/media/p2p/') ||
		// This file names them in order to ban them.
		relative === 'lib/media/no-provider-names.spec.ts'
	);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry === '.svelte-kit') continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) sourceFiles(full, out);
		else if (/\.(ts|svelte)$/.test(entry)) out.push(full);
	}
	return out;
}

/**
 * Strip comments. Prose may discuss the mechanism freely — explaining WHY the
 * seam hides `RTCPeerConnection` is exactly the kind of comment this codebase
 * wants, and a checker that forbade it would push the reasoning out of the
 * files that need it.
 */
function codeOf(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/[^\n]*/g, '');
}

describe('no provider names above the transport seam (AR-TRANSPORT-10)', () => {
	const files = sourceFiles(SRC)
		.map((f) => [f.slice(SRC.length), f] as const)
		.filter(([relative]) => !isExempt(relative));

	it('finds source files to check', () => {
		// A path change that silently emptied this list would make every
		// assertion below vacuously true — the failure mode this project has
		// been bitten by more than once.
		expect(files.length).toBeGreaterThan(50);
	});

	it.each(files)('%s names no provider', (_relative, file) => {
		const offending = codeOf(readFileSync(file, 'utf8'))
			.split('\n')
			.map((line, i) => ({ line: line.trim(), number: i + 1 }))
			.filter(({ line }) => PROVIDER_NOUNS.test(line));
		expect(offending.map((o) => `${String(o.number)}: ${o.line}`)).toEqual([]);
	});
});
