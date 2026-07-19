import { describe, expect, it } from 'vitest';
import { newNote, newTimer, newChat } from './create';
import { minSizeFor } from '$lib/canvas/resize';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const CENTRE = { x: 0, y: 0 };

/**
 * A new object must be born big enough to USE.
 *
 * The timer shipped with a 180x120 default against a 190x170 minimum — every
 * timer appeared too small for its own controls and had to be resized before
 * it could be operated. Two numbers in two files that must agree, with nothing
 * making them agree.
 */
describe('default sizes clear their own minimums', () => {
	const cases = [
		{ type: 'note' as const, make: newNote },
		{ type: 'timer' as const, make: newTimer },
		{ type: 'chat' as const, make: newChat }
	];

	for (const { type, make } of cases) {
		it(`a new ${type} is at least its minimum size`, () => {
			const object = make(ACTOR, CENTRE, 0);
			const min = minSizeFor(type);
			expect(object.transform.width, `${type} width`).toBeGreaterThanOrEqual(min.width);
			expect(object.transform.height, `${type} height`).toBeGreaterThanOrEqual(min.height);
		});
	}

	it('a new object is CENTRED on the requested point', () => {
		// Otherwise resizing the default silently moves it: the offsets are
		// written by hand as half the size, so changing one and not the other
		// puts new objects off-centre from where the user asked.
		for (const { make } of cases) {
			const object = make(ACTOR, CENTRE, 0);
			expect(object.transform.x + object.transform.width / 2).toBeCloseTo(0, 5);
			expect(object.transform.y + object.transform.height / 2).toBeCloseTo(0, 5);
		}
	});
});
