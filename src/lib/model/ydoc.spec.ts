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
