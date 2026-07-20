import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ImageObject from './ImageObject.svelte';
import { newImage, type ImageRef } from '$lib/model/create';
import type { ImageCanvasObject } from '$lib/model/types';

/**
 * The image object's rendering (UX-OBJ-5, UX-A11Y-3).
 *
 * A real browser, so `getComputedStyle` returns real values and the `<img>`
 * really decodes — a jsdom render would assert `object-fit` against a zero and
 * never fire the load/error events these tests turn on (AR-TEST-3). The signed
 * URL is passed in as `src`, so this needs no Supabase client: the component is
 * pure by design.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';

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
		void render(ImageObject, { object: object({ alt: 'a purple square' }), src: pngUrl() });
		await expect.element(page.getByRole('img', { name: 'a purple square' })).toBeInTheDocument();
	});

	it('falls back to "Image" when the alt is empty', async () => {
		void render(ImageObject, { object: object({ alt: '' }), src: pngUrl() });
		await expect.element(page.getByRole('img', { name: 'Image' })).toBeInTheDocument();
	});

	it('contains the picture rather than cropping it', async () => {
		void render(ImageObject, { object: object(), src: pngUrl() });
		await expect.element(page.getByRole('img')).toBeInTheDocument();
		expect(getComputedStyle(img()).objectFit).toBe('contain');
	});
});

describe('before and instead of a picture', () => {
	it('shows a loading placeholder while the src is unresolved', async () => {
		void render(ImageObject, { object: object(), src: undefined });
		await expect.element(page.getByText('Loading image…')).toBeInTheDocument();
		expect(document.querySelector('img')).toBeNull();
	});

	it('shows a could-not-load message when the bytes fail to decode', async () => {
		// A src that is a valid URL but not a decodable image fires onerror.
		void render(ImageObject, {
			object: object({ alt: 'broken' }),
			src: 'data:image/png;base64,not-an-image'
		});
		await expect.element(page.getByText('broken could not load')).toBeInTheDocument();
	});
});
