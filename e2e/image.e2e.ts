import { expect, test } from '@playwright/test';
import { SYNC, joinRoom, roomName, settled } from './support/join';

/**
 * Uploadable images (UX-OBJ-5).
 *
 * Unlike the media plane, an image needs no second machine and no WebRTC: the
 * bytes go to Storage and the OBJECT is ordinary room state, so it syncs to
 * another client exactly like a note. What only an end-to-end run proves is the
 * whole chain the units cannot see at once — a real file through the client
 * caps, a real upload to the local Storage bucket under its RLS, the
 * create_object mutation, and the signed URL minted back on the far side into an
 * `<img>` that actually loads.
 *
 * The one thing untested here, per AR-TEST-10's spirit: nothing drives the OS
 * file dialog — Playwright's `setInputFiles` sets the hidden input directly,
 * which is the whole point of routing the button through a real
 * `<input type="file">`. The bytes and the validation past that point are real.
 */

/** A real, decodable 4×4 truecolor PNG — inline, and maximally compatible with
    `createImageBitmap` (the validation decodes it before upload). */
const PNG_IMAGE = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGOoiPoPRwzEcQDrgh0RzzDxZgAAAABJRU5ErkJggg==',
	'base64'
);

test('an uploaded image becomes an object with its filename as alt (UX-OBJ-5)', async ({
	browser
}) => {
	// A generous budget, like the media tests: an image adds a real Storage upload
	// BEFORE the create mutation, and the first round-trip on a cold worker is the
	// slow one. This is latency, not a different outcome.
	test.setTimeout(120_000);
	const APPEAR = 60_000;

	const room = roomName('image');
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();

	await joinRoom(a, room, 'Uploader');
	await settled(a);
	// b shares a's context (and so its identity), so joining only navigates — no
	// name prompt. It is here to prove the image reaches ANOTHER viewer.
	await joinRoom(b, room, 'Uploader');

	// setInputFiles on the hidden picker — the button that opens it is what a
	// person clicks, but the file itself cannot be chosen through a real dialog.
	await a.locator('input[type="file"]').setInputFiles({
		name: 'sunset.png',
		mimeType: 'image/png',
		buffer: PNG_IMAGE
	});

	// The object appears for the uploader, its accessible name derived from the
	// filename (UX-A11Y-3), and the picture actually decodes.
	const image = a.locator('[data-object-type="image"]');
	await expect(image).toHaveCount(1, { timeout: APPEAR });
	// The <img>'s accessible name is the alt itself, seeded from the filename
	// (UX-A11Y-3). ("Image: sunset" is the frame's label, a level up.)
	await expect(a.getByRole('img', { name: 'sunset' })).toBeVisible({ timeout: SYNC });
	await expect
		.poll(
			async () =>
				a
					.locator('[data-object-type="image"] img')
					.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
			{ timeout: SYNC, intervals: [250] }
		)
		.toBe(true);

	// It is room state, so the other client sees it too — the same sync path a
	// note takes, which is the whole claim that an image is "an object like any
	// other".
	await expect(b.locator('[data-object-type="image"]')).toHaveCount(1, { timeout: APPEAR });

	// And every canvas interaction is inherited from ObjectFrame with no new code:
	// fullscreen (UX-CANVAS-4) opens the same overlay a note gets.
	await a.getByRole('button', { name: 'Fill screen with this object' }).click();
	const overlay = a.getByRole('dialog', { name: 'Fullscreen object' });
	await expect(overlay).toBeVisible();
	await expect(overlay.getByRole('img', { name: 'sunset' })).toBeVisible();
	await a.keyboard.press('Escape');
	await expect(a.getByRole('dialog')).toHaveCount(0);

	// Deleting the image removes it for everyone. Server-side the same request
	// also deletes the blob (asserted directly in
	// image-cleanup.integration.spec.ts); here we exercise the delete path end to
	// end, which is what runs that cleanup.
	const frame = a.getByRole('group', { name: /^Image/ });
	await frame.hover();
	await a.getByRole('button', { name: 'Delete image' }).click();
	await expect(image).toHaveCount(0, { timeout: APPEAR });
	await expect(b.locator('[data-object-type="image"]')).toHaveCount(0, { timeout: APPEAR });

	await context.close();
});

test('a file that is not a supported image is refused, and says so (UX-OBJ-5)', async ({
	browser
}) => {
	const room = roomName('imagebad');
	const context = await browser.newContext();
	const page = await context.newPage();

	await joinRoom(page, room, 'Uploader');
	await settled(page);

	// A text file passes the input's accept filter only because setInputFiles
	// bypasses it — which is exactly why the JS validation, not the picker, is the
	// gate that matters.
	await page.locator('input[type="file"]').setInputFiles({
		name: 'notes.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('not an image at all')
	});

	// No object is created, and the refusal is ANNOUNCED (UX-A11Y-3) rather than
	// silent — the live region a screen reader hears.
	await expect(page.locator('.sr-only[aria-live]')).toContainText(/not a supported image/i, {
		timeout: SYNC
	});
	await expect(page.locator('[data-object-type="image"]')).toHaveCount(0);

	await context.close();
});

test('dropping an image file onto the canvas adds it (UX-OBJ-5)', async ({ browser }) => {
	test.setTimeout(120_000);
	const context = await browser.newContext();
	const page = await context.newPage();

	await joinRoom(page, roomName('imagedrop'), 'Dropper');
	await settled(page);

	// Build a real File in a DataTransfer and dispatch a drop — the only way to
	// drive a file drop in Playwright (there is no OS drag to simulate). The drop
	// handler lives on <main>; dispatching on the canvas bubbles up to it.
	const dataTransfer = await page.evaluateHandle((b64: string) => {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const dt = new DataTransfer();
		dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
		return dt;
	}, PNG_IMAGE.toString('base64'));

	const canvas = page.getByRole('application', { name: 'Room canvas' });
	await canvas.dispatchEvent('dragover', { dataTransfer });
	await canvas.dispatchEvent('drop', { dataTransfer });

	// The dropped file became an image object, alt seeded from its filename.
	await expect(page.locator('[data-object-type="image"]')).toHaveCount(1, { timeout: 60_000 });
	await expect(page.getByRole('img', { name: 'dropped' })).toBeVisible({ timeout: 60_000 });

	await context.close();
});
