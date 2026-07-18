import { describe, expect, it } from 'vitest';
import {
	RESERVED_NAMES,
	canonicalRoomName,
	isValidRoomName,
	roomNameMessage,
	roomNameProblem
} from './room-name';

describe('room names (UX-ROOM-9)', () => {
	it('accepts lowercase letters, digits, dash and underscore, 2–32 long', () => {
		for (const name of ['lci', 'stand-up', 'retro_2', 'a1', 'x'.repeat(32)]) {
			expect(isValidRoomName(name), name).toBe(true);
		}
	});

	it('rejects the wrong shape', () => {
		for (const name of ['a', '', 'x'.repeat(33), 'has space', 'sym+bol', 'dot.name', 'sla/sh']) {
			expect(roomNameProblem(name), name).toBe('shape');
		}
	});

	it('compares case-insensitively, so LCI and lci are one room', () => {
		// The requirement's exact example. Canonicalizing here is what stops a
		// third call site forgetting its own .toLowerCase().
		expect(canonicalRoomName('LCI')).toBe('lci');
		expect(canonicalRoomName('  Stand-Up  ')).toBe('stand-up');
		expect(isValidRoomName('LCI')).toBe(true);
	});

	it('rejects reserved names, in any case', () => {
		expect(roomNameProblem('admin')).toBe('reserved');
		expect(roomNameProblem('ADMIN')).toBe('reserved');
		expect(roomNameProblem('  Login ')).toBe('reserved');
	});

	it('every reserved name is otherwise well-shaped', () => {
		// A reserved entry that could never be typed anyway is dead weight, and
		// would hide a typo in the list.
		for (const name of RESERVED_NAMES) {
			expect(canonicalRoomName(name), name).toBe(name);
			expect(name.length, name).toBeGreaterThanOrEqual(2);
			expect(name.length, name).toBeLessThanOrEqual(32);
		}
	});

	it('explains which rule was broken', () => {
		expect(roomNameMessage('reserved')).toContain('reserved');
		expect(roomNameMessage('shape')).toContain('2–32');
	});
});
