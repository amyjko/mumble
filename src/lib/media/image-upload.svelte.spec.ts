import { describe, expect, it } from 'vitest';
import { validateImageFile, imageFilesFrom, ImageUploadError } from './image-upload';
import { MAX_IMAGE_BYTES, MAX_IMAGE_DIM } from '$lib/model/image';

/**
 * The CLIENT half of the image caps (UX-OBJ-5).
 *
 * A real browser, because the subject is decoding: `createImageBitmap` needs a
 * real image codec, which jsdom does not have (AR-TEST-3). Only `validateImageFile`
 * is exercised here — the upload itself needs a live bucket and belongs to the
 * e2e. Bytes and mime also have a REAL gate below this (the bucket); dimensions
 * do not, so this decode is the whole client-side dimension story.
 */

/** A real PNG File at a chosen pixel size. */
async function png(width: number, height: number): Promise<File> {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (context === null) throw new Error('no 2d context');
	context.fillStyle = '#123456';
	context.fillRect(0, 0, width, height);
	const blob = await new Promise<Blob | null>((resolve) => {
		canvas.toBlob(resolve, 'image/png');
	});
	if (blob === null) throw new Error('no blob');
	return new File([blob], 'picture.png', { type: 'image/png' });
}

describe('validateImageFile', () => {
	it('accepts a normal image and returns its decoded size and mime', async () => {
		const result = await validateImageFile(await png(120, 90));
		expect(result).toEqual({ width: 120, height: 90, mime: 'image/png' });
	});

	it('rejects a file whose type is not a supported image', async () => {
		const notImage = new File(['plain text'], 'notes.txt', { type: 'text/plain' });
		await expect(validateImageFile(notImage)).rejects.toBeInstanceOf(ImageUploadError);
	});

	it('rejects a file over the byte cap', async () => {
		// A blob padded past the cap; type is fine, so this isolates the byte check.
		const padding = new Uint8Array(MAX_IMAGE_BYTES + 1);
		const tooBig = new File([padding], 'huge.png', { type: 'image/png' });
		await expect(validateImageFile(tooBig)).rejects.toBeInstanceOf(ImageUploadError);
	});

	it('rejects an image past the pixel cap on a side', async () => {
		const tooWide = await png(MAX_IMAGE_DIM + 1, 10);
		await expect(validateImageFile(tooWide)).rejects.toBeInstanceOf(ImageUploadError);
	});

	it('rejects bytes that claim an image mime but do not decode', async () => {
		const undecodable = new File([new Uint8Array([1, 2, 3, 4])], 'broken.png', {
			type: 'image/png'
		});
		await expect(validateImageFile(undecodable)).rejects.toBeInstanceOf(ImageUploadError);
	});
});

describe('imageFilesFrom (drop/paste extraction)', () => {
	/** A real FileList, the only way to make one — via DataTransfer. */
	function fileList(...files: File[]): FileList {
		const dt = new DataTransfer();
		for (const file of files) dt.items.add(file);
		return dt.files;
	}
	const png = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
	const gif = new File([new Uint8Array([1])], 'b.gif', { type: 'image/gif' });
	const text = new File(['hi'], 'c.txt', { type: 'text/plain' });

	it('keeps image files and drops the rest', () => {
		expect(imageFilesFrom(fileList(png, text, gif))).toEqual([png, gif]);
	});

	it('returns empty when nothing is an image', () => {
		expect(imageFilesFrom(fileList(text))).toEqual([]);
	});

	it('handles a null list (no dataTransfer / clipboard files)', () => {
		expect(imageFilesFrom(null)).toEqual([]);
	});
});
