import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
	applyEncodedUpdate,
	docFromEncoded,
	encodeDoc,
	encodeUpdateSince,
	encodedFromText,
	mergeEncoded,
	noteText,
	textType
} from './ydoc';

/**
 * The CRDT boundary (AR-SYNC-4). These assert the property that justifies the
 * dependency: concurrent edits MERGE rather than one overwriting the other.
 */

describe('note documents round-trip through JSON-safe strings', () => {
	it('encodes and decodes text', () => {
		const encoded = encodedFromText('hello');
		expect(noteText(docFromEncoded(encoded))).toBe('hello');
	});

	it('survives an empty document', () => {
		expect(noteText(docFromEncoded(''))).toBe('');
	});

	it('drops a malformed update instead of throwing', () => {
		// Updates cross a trust boundary — another tab today, another client
		// later — so a corrupt one must be dropped like any bad input.
		const doc = docFromEncoded(encodedFromText('intact'));
		expect(applyEncodedUpdate(doc, 'not-base64-at-all!!')).toBe(false);
		expect(noteText(doc)).toBe('intact');
	});
});

describe('concurrent editing converges', () => {
	it('keeps BOTH edits when two people type at once', () => {
		// The property last-writer-wins could never have: two people editing
		// the same note from the same starting point, neither losing work.
		const base = encodedFromText('shared');
		const alice = docFromEncoded(base);
		const bob = docFromEncoded(base);

		textType(alice).insert(0, 'A:');
		textType(bob).insert(textType(bob).length, '!B');

		const merged = mergeEncoded(encodeDoc(alice), encodeDoc(bob));
		const text = noteText(docFromEncoded(merged));
		expect(text).toContain('A:');
		expect(text).toContain('!B');
		expect(text).toContain('shared');
	});

	it('converges to the SAME text regardless of merge order', () => {
		// Order-independence is what makes it safe to merge whichever snapshot
		// happens to arrive first — the store cannot control that ordering.
		const base = encodedFromText('base');
		const alice = docFromEncoded(base);
		const bob = docFromEncoded(base);
		textType(alice).insert(0, 'left ');
		textType(bob).insert(textType(bob).length, ' right');

		const ab = noteText(docFromEncoded(mergeEncoded(encodeDoc(alice), encodeDoc(bob))));
		const ba = noteText(docFromEncoded(mergeEncoded(encodeDoc(bob), encodeDoc(alice))));
		expect(ab).toBe(ba);
	});

	it('merging is idempotent, so replayed snapshots are harmless', () => {
		// The store merges every inbound snapshot, including ones it has
		// already seen. Re-applying must not duplicate characters.
		const once = mergeEncoded(encodedFromText('x'), encodedFromText(''));
		const twice = mergeEncoded(once, once);
		expect(noteText(docFromEncoded(twice))).toBe(noteText(docFromEncoded(once)));
	});
});

describe('delta updates', () => {
	it('carries only what changed since a state vector', () => {
		// The peer must share the SAME base document, not merely the same text:
		// a delta references the operations it builds on, so a peer that typed
		// "start" independently has different operations and cannot integrate
		// it. That is why the store persists `doc` and not just `text`.
		const base = encodedFromText('start');
		const doc = docFromEncoded(base);
		const before = Y.encodeStateVector(doc);
		textType(doc).insert(textType(doc).length, ' more');

		const delta = encodeUpdateSince(doc, before);
		const full = encodeDoc(doc);
		// A keystroke should cost a keystroke, not the whole note.
		expect(delta.length).toBeLessThan(full.length);

		// And the delta brings a peer holding that base fully up to date.
		const peer = docFromEncoded(base);
		expect(applyEncodedUpdate(peer, delta)).toBe(true);
		expect(noteText(peer)).toBe('start more');
	});
});

/**
 * Document growth (the AR-SYNC-4 open item), settled by measurement.
 *
 * The worry was that a Yjs doc grows with edit history until it cannot be
 * stored or broadcast. Measured on 2026-07-19 it does not, at anything like
 * this product's scale: a ~500-character sticky note typed one character at a
 * time encodes to 0.5 KB, because Yjs merges adjacent items from the same
 * client. 5500 characters with heavy delete/retype churn is 5.4 KB — overhead
 * roughly equal to the text, not exponential in edits.
 *
 * The two things that DO drive growth are pinned below, because both are
 * load-bearing and neither is obvious from reading the code.
 */
describe('document growth stays proportional to text', () => {
	const sentence = 'We should ship the smaller thing first and see what breaks. ';

	function typed(text: string): Y.Doc {
		const doc = new Y.Doc();
		const body = doc.getText('body');
		for (const ch of text) {
			doc.transact(() => {
				body.insert(body.length, ch);
			});
		}
		return doc;
	}

	it('char-by-char typing does not multiply the stored size', () => {
		const doc = typed(sentence.repeat(9));
		const bytes = Y.encodeStateAsUpdate(doc).byteLength;
		// ~540 chars of text. Generous ceiling: the point is the ORDER of
		// magnitude, not the exact encoding, which is Yjs's to change.
		expect(bytes).toBeLessThan(4096);
	});

	it('GARBAGE COLLECTION is load-bearing, not incidental', () => {
		// `new Y.Doc()` defaults to gc: true and nothing in ydoc.ts overrides it.
		// If someone ever passes { gc: false } — a reasonable-looking change if
		// you want history — deleted text stops being reclaimed and documents
		// grow without bound. Measured: 5000 chars deleted is 0.1 KB collected
		// versus 5.0 KB uncollected, a 50x difference that would appear as a
		// mysterious storage problem months later.
		const collected = typed(sentence.repeat(85));
		collected.transact(() => {
			collected.getText('body').delete(0, 5000);
		});

		const retained = new Y.Doc({ gc: false });
		const body = retained.getText('body');
		for (const ch of sentence.repeat(85)) {
			retained.transact(() => {
				body.insert(body.length, ch);
			});
		}
		retained.transact(() => {
			body.delete(0, 5000);
		});

		expect(Y.encodeStateAsUpdate(collected).byteLength).toBeLessThan(
			Y.encodeStateAsUpdate(retained).byteLength / 5
		);
	});
});
