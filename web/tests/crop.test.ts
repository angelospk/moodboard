import { describe, expect, it } from 'vitest';
import { cropAspect, imgPlacement, FULL } from '../src/lib/crop.js';

describe('cropAspect', () => {
	it('is the image aspect ratio without a crop', () => {
		expect(cropAspect(null, 1.5)).toBe(1.5);
	});
	it('scales the image aspect ratio by the crop shape', () => {
		// A 1600x800 image (2:1), left half kept: 800x800.
		expect(cropAspect({ x: 0, y: 0, w: 0.5, h: 1 }, 2)).toBeCloseTo(1);
		// Top quarter of a 1000x1000 image: 1000x250.
		expect(cropAspect({ x: 0, y: 0, w: 1, h: 0.25 }, 1)).toBeCloseTo(4);
	});
	it('falls back to 4:3 for an unknown image size', () => {
		expect(cropAspect(null, 0)).toBeCloseTo(4 / 3);
		expect(cropAspect(null, Number.NaN)).toBeCloseTo(4 / 3);
	});
});

describe('imgPlacement', () => {
	it('fills the frame without a crop', () => {
		expect(imgPlacement(null)).toEqual({ left: 0, top: 0, width: 100, height: 100 });
		expect(imgPlacement(FULL)).toEqual({ left: 0, top: 0, width: 100, height: 100 });
	});
	it('makes the whole image larger than the frame and moves the kept part into it', () => {
		const p = imgPlacement({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 });
		expect(p.width).toBeCloseTo(200);
		expect(p.height).toBeCloseTo(400);
		expect(p.left).toBeCloseTo(-50);
		expect(p.top).toBeCloseTo(-200);
		// The kept part's corners land on the frame's corners.
		expect(p.left + 0.25 * p.width).toBeCloseTo(0);
		expect(p.left + 0.75 * p.width).toBeCloseTo(100);
		expect(p.top + 0.5 * p.height).toBeCloseTo(0);
		expect(p.top + 0.75 * p.height).toBeCloseTo(100);
	});
	it('ignores a broken crop (zero or negative size, outside the image)', () => {
		expect(imgPlacement({ x: 0, y: 0, w: 0, h: 0.5 })).toEqual(imgPlacement(null));
		expect(imgPlacement({ x: 0.9, y: 0, w: 0.5, h: 0.5 })).toEqual(imgPlacement(null));
	});
});
