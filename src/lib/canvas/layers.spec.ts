import { describe, expect, it } from 'vitest';
import { AVATAR_Z, PLACER_Z, RAISED_Z } from './layers';

/**
 * The stacking order is a RELATIONSHIP, and a relationship is testable in a
 * way three separate constants are not.
 *
 * layers.ts already argued that these must not be split across components —
 * and then PLACER_Z spent a day as a bare `900` in PlacerMarker's CSS anyway.
 * A comment cannot fail; this can.
 */
describe('world stacking order', () => {
	it('places markers under people, people under content that is reached for', () => {
		// Each inequality is a separate product rule:
		// a placer must not hide the person standing in it...
		expect(PLACER_Z).toBeLessThan(AVATAR_Z);
		// ...and a hovered object must outrank avatars, or its controls sit
		// under someone's face and cannot be clicked (UX-OBJ-14).
		expect(AVATAR_Z).toBeLessThan(RAISED_Z);
	});

	it('leaves room between the layers for objects to interleave', () => {
		// Object z comes from content and is unbounded below AVATAR_Z. Adjacent
		// constants would leave no room and force a migration the first time
		// anything needs to sit between two of these.
		expect(AVATAR_Z - PLACER_Z).toBeGreaterThanOrEqual(50);
		expect(RAISED_Z - AVATAR_Z).toBeGreaterThanOrEqual(50);
	});
});
