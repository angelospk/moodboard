// Upload compression: a large photo is made smaller in the browser before it goes to the server.
import { describe, expect, it } from 'vitest';
import { compressImage, isAnimated, MAX_EDGE, resizePlan } from '../src/lib/compress';

const MB = 1024 * 1024;

describe('resizePlan', () => {
	it('keeps a small image as it is', () => {
		expect(resizePlan({ width: 1200, height: 800, type: 'image/jpeg', size: 300_000 })).toBeNull();
		expect(resizePlan({ width: MAX_EDGE, height: 1000, type: 'image/png', size: MB })).toBeNull();
	});

	it('never touches a GIF (it may be animated)', () => {
		expect(resizePlan({ width: 6000, height: 4000, type: 'image/gif', size: 9 * MB })).toBeNull();
	});

	it('scales the long edge down to MAX_EDGE and keeps the aspect ratio', () => {
		expect(MAX_EDGE).toBe(2560);
		expect(resizePlan({ width: 6000, height: 4000, type: 'image/jpeg', size: 7 * MB })).toEqual({
			width: 2560,
			height: 1707,
			type: 'image/webp',
			quality: 0.86
		});
		expect(resizePlan({ width: 3000, height: 5120, type: 'image/png', size: 2 * MB })).toEqual({
			width: 1500,
			height: 2560,
			type: 'image/webp',
			quality: 0.86
		});
	});

	it('re-encodes a heavy file that is already small enough in pixels, without upscaling', () => {
		expect(resizePlan({ width: 2000, height: 1500, type: 'image/png', size: 4 * MB })).toEqual({
			width: 2000,
			height: 1500,
			type: 'image/webp',
			quality: 0.86
		});
	});

	it('keeps a file of at most 1.5 MB when its pixels fit', () => {
		expect(resizePlan({ width: 2000, height: 1500, type: 'image/jpeg', size: 1.5 * MB })).toBeNull();
	});
});

describe('compressImage', () => {
	it('returns the file unchanged where the browser image APIs are missing (here: Node)', async () => {
		const f = new Blob([new Uint8Array(3 * MB)], { type: 'image/jpeg' });
		expect(await compressImage(f)).toBe(f);
	});

	it('returns a GIF unchanged', async () => {
		const f = new Blob([new Uint8Array(10)], { type: 'image/gif' });
		expect(await compressImage(f)).toBe(f);
	});
});

describe('isAnimated', () => {
	const bytes = (...parts: (string | number[])[]) =>
		new Blob(parts.map((p) => (typeof p === 'string' ? new TextEncoder().encode(p) : new Uint8Array(p))));
	const pngHead = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

	it('finds an APNG (acTL before IDAT) and passes a plain PNG', async () => {
		expect(await isAnimated(bytes(pngHead, [0, 0, 0, 13], 'IHDR', new Array(17).fill(0), [0, 0, 0, 8], 'acTL', new Array(12).fill(0), 'IDAT'), 'image/png')).toBe(true);
		expect(await isAnimated(bytes(pngHead, [0, 0, 0, 13], 'IHDR', new Array(17).fill(0), [0, 0, 0, 0], 'IDAT'), 'image/png')).toBe(false);
	});

	it('finds an animated WebP (VP8X animation flag) and passes a still one', async () => {
		const vp8x = (flags: number) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8X', [10, 0, 0, 0, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(await isAnimated(vp8x(0x02), 'image/webp')).toBe(true);
		expect(await isAnimated(vp8x(0x10), 'image/webp')).toBe(false);
		expect(await isAnimated(bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8 ', [0, 0, 0, 0]), 'image/webp')).toBe(false);
	});

	it('a JPEG is never animated', async () => {
		expect(await isAnimated(bytes('acTL'), 'image/jpeg')).toBe(false);
	});
});
