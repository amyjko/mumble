import * as Y from 'yjs';

/**
 * The CRDT boundary for note text (AR-SYNC-4).
 *
 * Yjs speaks Uint8Array; the room state is JSON that has to survive
 * localStorage and structuredClone. This module is the only place that
 * converts between them, so the base64 round-trip is written once and audited
 * once rather than sprinkled through the store and the components.
 *
 * WHY A DEPENDENCY. The project's norm is no dependencies, deliberately bent
 * here. The expensive part of a hand-rolled CRDT is not the merge algorithm
 * (~300–500 lines) but the caret- and IME-preservation layer over a textarea,
 * which is where these implementations actually fail and which is hard to
 * test. DESIGN.md AR-SYNC-4 already named Yjs; this ratifies it.
 */

/** The single Y.Text name inside a note's document. */
const TEXT_KEY = 'text';

export function noteText(doc: Y.Doc): string {
	// toJSON(), not toString(): Y.Text's typings declare the former as
	// returning string and never declare the latter, so `.toString()` types as
	// Object's default stringification even though Yjs defines one at runtime.
	return doc.getText(TEXT_KEY).toJSON();
}

export function textType(doc: Y.Doc): Y.Text {
	return doc.getText(TEXT_KEY);
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** The document's full state, as a string safe for JSON and postMessage. */
export function encodeDoc(doc: Y.Doc): string {
	return toBase64(Y.encodeStateAsUpdate(doc));
}

/**
 * Apply an encoded update. Returns false for anything unparseable rather than
 * throwing: updates arrive from other tabs and, later, other clients, so a
 * malformed one must be dropped like any other bad boundary input — never
 * allowed to take down the store.
 */
export function applyEncodedUpdate(doc: Y.Doc, encoded: string): boolean {
	if (encoded === '') return false;
	try {
		Y.applyUpdate(doc, fromBase64(encoded));
		return true;
	} catch {
		console.warn('mumble: dropped malformed note update');
		return false;
	}
}

/** A fresh document seeded from encoded state ('' yields an empty document). */
export function docFromEncoded(encoded: string): Y.Doc {
	const doc = new Y.Doc();
	applyEncodedUpdate(doc, encoded);
	return doc;
}

/**
 * MERGE two encoded states, rather than letting one win.
 *
 * This is the whole reason CRDT changes the store's receive path: a room
 * snapshot arriving from another tab used to REPLACE local state, so
 * simultaneous typing in two tabs meant the later snapshot silently discarded
 * the earlier one's characters. Merging is what makes concurrent editing
 * converge instead of race.
 */
export function mergeEncoded(a: string, b: string): string {
	const doc = docFromEncoded(a);
	applyEncodedUpdate(doc, b);
	return encodeDoc(doc);
}

/**
 * The update carrying everything this document gained since `stateVector`.
 *
 * Sending a delta rather than the whole document keeps a keystroke a
 * keystroke: full-state sends would grow with the note and make every edit
 * cost more than the last.
 */
export function encodeUpdateSince(doc: Y.Doc, stateVector: Uint8Array): string {
	return toBase64(Y.encodeStateAsUpdate(doc, stateVector));
}

/** Encoded state for a document containing exactly `text` — for seeding. */
export function encodedFromText(text: string): string {
	const doc = new Y.Doc();
	if (text !== '') doc.getText(TEXT_KEY).insert(0, text);
	return encodeDoc(doc);
}
