import { beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import VoiceControl from './VoiceControl.svelte';
import { voicePreferences } from './voice.svelte';

/**
 * Turning one person down, for yourself only (UX-OBJ-16 × UX-AUDIO).
 *
 * The open item this closes said a screen share's sound had a per-viewer mute
 * and a person's voice had nothing. These are the assertions that keep the two
 * from drifting apart again — and, more importantly, that keep this control
 * LOCAL. A mute that ever became a broadcast would be a moderation feature
 * wearing a listening feature's clothes, and the person muted would have no
 * idea it had happened.
 */

describe('voicePreferences', () => {
	beforeEach(() => {
		voicePreferences.clear();
	});

	it('defaults to audible at full volume', () => {
		// Somebody nobody has touched must be heard. A default of "muted" would
		// be a room that is silent until every viewer configures it.
		expect(voicePreferences.for('nobody')).toEqual({ muted: false, volume: 1 });
	});

	it('remembers a choice per person, not per room', () => {
		voicePreferences.setMuted('alice', true);
		voicePreferences.setVolume('bob', 0.4);
		expect(voicePreferences.for('alice').muted).toBe(true);
		expect(voicePreferences.for('bob').muted).toBe(false);
		expect(voicePreferences.for('bob').volume).toBe(0.4);
		// Muting one person must not touch anyone else's volume.
		expect(voicePreferences.for('alice').volume).toBe(1);
	});

	it('clamps volume, because an element misbehaves silently out of range', () => {
		voicePreferences.setVolume('alice', 5);
		expect(voicePreferences.for('alice').volume).toBe(1);
		voicePreferences.setVolume('alice', -3);
		expect(voicePreferences.for('alice').volume).toBe(0);
	});

	it('mute and volume are independent, so unmuting restores the level', () => {
		// Muting by setting volume to zero would lose the level someone chose.
		voicePreferences.setVolume('alice', 0.3);
		voicePreferences.setMuted('alice', true);
		voicePreferences.setMuted('alice', false);
		expect(voicePreferences.for('alice').volume).toBe(0.3);
	});

	it('tracks a refused autoplay for the whole document, not per peer', () => {
		// Autoplay is a per-DOCUMENT policy: if one voice is refused they all
		// are. A per-peer flag would ask someone to unblock each speaker in turn.
		expect(voicePreferences.blocked).toBe(false);
		voicePreferences.reportBlocked();
		expect(voicePreferences.blocked).toBe(true);
		voicePreferences.allow();
		expect(voicePreferences.blocked).toBe(false);
	});
});

describe('VoiceControl', () => {
	beforeEach(() => {
		voicePreferences.clear();
	});

	it('names the person in its controls, since a room holds several', async () => {
		// UX-A11Y-1: "Mute" alone is ambiguous to anyone navigating by control.
		await render(VoiceControl, { id: 'alice', name: 'Ada' });
		await expect.element(page.getByRole('button', { name: 'Mute Ada for yourself' })).toBeVisible();
		await expect.element(page.getByRole('slider', { name: 'Volume for Ada' })).toBeVisible();
	});

	it('mutes and unmutes, and says which it is doing', async () => {
		await render(VoiceControl, { id: 'alice', name: 'Ada' });
		await page.getByRole('button', { name: 'Mute Ada for yourself' }).click();

		expect(voicePreferences.for('alice').muted).toBe(true);
		// The label flips, so the control says what it will do NEXT rather than
		// what state it is in — the same contract Button's toggle tests pin.
		await expect
			.element(page.getByRole('button', { name: 'Unmute Ada for yourself' }))
			.toBeVisible();
	});

	it('disables the slider while muted, rather than letting it lie', async () => {
		// A live-looking volume control that changes nothing audible is worse
		// than one that is visibly unavailable.
		await render(VoiceControl, { id: 'alice', name: 'Ada' });
		await page.getByRole('button', { name: 'Mute Ada for yourself' }).click();
		await expect.element(page.getByRole('slider', { name: 'Volume for Ada' })).toBeDisabled();
	});

	it('writes the volume it is dragged to', async () => {
		await render(VoiceControl, { id: 'alice', name: 'Ada' });
		const slider = page.getByRole('slider', { name: 'Volume for Ada' });
		await slider.fill('0.25');
		expect(voicePreferences.for('alice').volume).toBe(0.25);
	});
});
