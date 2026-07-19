import { describe, expect, it } from 'vitest';
import { AVATAR_SIZE, newParticipant } from './avatar';
import { participantSchema } from './schemas';
import type { Participant } from './types';

const IDENTITY = { id: '11111111-1111-4111-8111-111111111111', name: 'Ada', emoji: '🐢' };

describe('newParticipant (UX-AV-1/9, UX-STAGE-10)', () => {
	it('produces something the schema accepts', () => {
		// The defaults were previously written out in Room.svelte and DevPanel,
		// where nothing checked them against participantSchema at all.
		expect(() => participantSchema.parse(newParticipant(IDENTITY))).not.toThrow();
	});

	it('agrees with the SCHEMA defaults rather than restating them', () => {
		// Two sources for one fact: the constructor (new participants) and the
		// schema default (participants stored before a field existed). If they
		// disagree, a room quietly contains two kinds of avatar with no user
		// action explaining the difference.
		const fromSchema = participantSchema.parse({
			id: IDENTITY.id,
			name: IDENTITY.name,
			emoji: IDENTITY.emoji,
			location: { x: 0, y: 0 },
			fake: false
		});
		const built = newParticipant(IDENTITY);
		expect(built.size).toEqual(fromSchema.size);
		expect(built.clip).toEqual(fromSchema.clip);
		expect(built.rotation).toBe(fromSchema.rotation);
		expect(built.muted).toBe(fromSchema.muted);
		expect(built.size.width).toBe(AVATAR_SIZE);
	});

	it('arrives MUTED, because that is a requirement and not a preference', () => {
		// UX-STAGE-10: you arrive silent and opt in. Also what stops a rejoin
		// silently re-taking an audio slot.
		expect(newParticipant(IDENTITY).muted).toBe(true);
	});

	it('carries an existing avatar across a rejoin, not just its position', () => {
		const existing: Participant = {
			...newParticipant(IDENTITY),
			location: { x: 300, y: 200 },
			size: { width: 140, height: 140 },
			rotation: 30,
			clip: { shape: 'ellipse' },
			away: true,
			muted: false
		};
		const back = newParticipant(IDENTITY, { existing });
		// UX-AV-1/9: your avatar is yours — size, shape, and state survive.
		expect(back).toMatchObject({
			location: { x: 300, y: 200 },
			size: { width: 140, height: 140 },
			rotation: 30,
			clip: { shape: 'ellipse' },
			away: true,
			muted: false
		});
	});

	it('marks fakes as fake, and puts them where asked', () => {
		const fake = newParticipant(IDENTITY, { fake: true, at: { x: 40, y: 80 } });
		expect(fake.fake).toBe(true);
		expect(fake.location).toEqual({ x: 40, y: 80 });
	});
});
