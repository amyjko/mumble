import { describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ImageObject from './ImageObject.svelte';
import { newImage, type ImageRef } from '$lib/model/create';
import type { ImageCanvasObject } from '$lib/model/types';
import { MemoryRoomStore } from '$lib/store/memory-store.svelte';
import { SyncClient } from '$lib/store/sync-client.svelte';

/**
 * The image object's rendering, alt caption, and URL-refresh signal (UX-OBJ-5,
 * UX-A11Y-3).
 *
 * A real browser, so `getComputedStyle` returns real values and the `<img>`
 * really fires load/error (AR-TEST-3). The signed URL is passed in as `src`, so
 * the picture side needs no Supabase client. The caption commits through a real
 * SyncClient over an in-memory store, spied at the commit boundary.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';

function sync(): SyncClient {
	return new SyncClient(new MemoryRoomStore(`img-${crypto.randomUUID()}`, OWNER));
}

/** A real, decodable PNG data URL — a 4×3 painted canvas. */
function pngUrl(): string {
	const canvas = document.createElement('canvas');
	canvas.width = 4;
	canvas.height = 3;
	const context = canvas.getContext('2d');
	if (context === null) throw new Error('no 2d context');
	context.fillStyle = '#7a5cff';
	context.fillRect(0, 0, canvas.width, canvas.height);
	return canvas.toDataURL('image/png');
}

function object(over: Partial<ImageRef> = {}): ImageCanvasObject {
	const ref: ImageRef = {
		path: 'room/key',
		width: 800,
		height: 600,
		mime: 'image/png',
		alt: 'a purple square',
		...over
	};
	return newImage(OWNER, { x: 0, y: 0 }, 0, ref);
}

/** The element under test, narrowed rather than cast (casts are banned). */
function img(): HTMLImageElement {
	const element = document.querySelector('img');
	if (!(element instanceof HTMLImageElement)) throw new Error('no img element');
	return element;
}

describe('a resolved image', () => {
	it('exposes its alt as the accessible name (UX-A11Y-3)', async () => {
		void render(ImageObject, {
			object: object({ alt: 'a purple square' }),
			sync: sync(),
			editable: false,
			src: pngUrl()
		});
		await expect.element(page.getByRole('img', { name: 'a purple square' })).toBeInTheDocument();
	});

	it('falls back to "Image" when the alt is empty', async () => {
		void render(ImageObject, {
			object: object({ alt: '' }),
			sync: sync(),
			editable: false,
			src: pngUrl()
		});
		await expect.element(page.getByRole('img', { name: 'Image' })).toBeInTheDocument();
	});

	it('contains the picture rather than cropping it', async () => {
		void render(ImageObject, { object: object(), sync: sync(), editable: false, src: pngUrl() });
		await expect.element(page.getByRole('img')).toBeInTheDocument();
		expect(getComputedStyle(img()).objectFit).toBe('contain');
	});

	it('loads lazily and decodes async (cheap room-load wins)', async () => {
		void render(ImageObject, { object: object(), sync: sync(), editable: false, src: pngUrl() });
		await expect.element(page.getByRole('img')).toBeInTheDocument();
		expect(img().getAttribute('loading')).toBe('lazy');
		expect(img().getAttribute('decoding')).toBe('async');
	});
});

describe('the alt caption (UX-A11Y-3)', () => {
	it('is an editable field, seeded from the alt, for someone with permission', async () => {
		void render(ImageObject, {
			object: object({ alt: 'a purple square' }),
			sync: sync(),
			editable: true,
			src: pngUrl()
		});
		const field = page.getByRole('textbox', { name: 'Image description' });
		await expect.element(field).toBeInTheDocument();
		await expect.element(field).toHaveValue('a purple square');
	});

	it('commits set_image_alt on blur (Enter)', async () => {
		const client = sync();
		const spy = vi.spyOn(client, 'commit');
		const obj = object({ alt: 'old' });
		void render(ImageObject, { object: obj, sync: client, editable: true, src: pngUrl() });

		const field = page.getByRole('textbox', { name: 'Image description' });
		await field.fill('a desert at dusk');
		await userEvent.keyboard('{Enter}'); // handler blurs → onblur commits

		await vi.waitFor(() => {
			expect(spy).toHaveBeenCalledWith({
				kind: 'set_image_alt',
				id: obj.id,
				alt: 'a desert at dusk'
			});
		});
	});

	it('shows read-only text, not an input, without edit permission', async () => {
		void render(ImageObject, {
			object: object({ alt: 'a purple square' }),
			sync: sync(),
			editable: false,
			src: pngUrl()
		});
		await expect.element(page.getByText('a purple square')).toBeInTheDocument();
		expect(document.querySelector('input')).toBeNull();
	});

	it('shows nothing when a non-editor views an image with no description', async () => {
		void render(ImageObject, {
			object: object({ alt: '' }),
			sync: sync(),
			editable: false,
			src: pngUrl()
		});
		await expect.element(page.getByRole('img')).toBeInTheDocument();
		// No caption element at all — an empty read-only bar would be noise.
		expect(document.querySelector('.caption')).toBeNull();
	});
});

describe('before and instead of a picture', () => {
	it('shows a loading placeholder while the src is unresolved', async () => {
		void render(ImageObject, { object: object(), sync: sync(), editable: false, src: undefined });
		await expect.element(page.getByText('Loading image…')).toBeInTheDocument();
		expect(document.querySelector('img')).toBeNull();
	});

	it('signals expiry and shows could-not-load when the bytes fail to decode', async () => {
		const expired = vi.fn();
		const obj = object({ alt: 'broken', path: 'room/blob-key' });
		// A src that is a valid URL but not a decodable image fires onerror.
		void render(ImageObject, {
			object: obj,
			sync: sync(),
			editable: false,
			src: 'data:image/png;base64,not-an-image',
			onexpired: expired
		});
		await expect.element(page.getByText('broken could not load')).toBeInTheDocument();
		// Room is asked to re-mint, and told WHICH blob by its path.
		expect(expired).toHaveBeenCalledWith('room/blob-key');
	});
});
