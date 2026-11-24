import { describe, expect, it } from 'vitest';
import { clampPan, loupeView, MAX_ZOOM, panBy, pinchView, pixelCap, RESET, wheelFactor, zoomAt, zoomTo } from '../src/lib/zoom.js';

const W = 800;
const H = 600;

describe('zoomAt', () => {
	it('keeps the point under the cursor in place', () => {
		const v = zoomAt(RESET, 2, 200, 150, W, H);
		expect(v.k).toBe(2);
		// The content point under (200, 150) was (200, 150); after zooming it must still be there.
		expect((200 - v.x) / v.k).toBeCloseTo(200);
		expect((150 - v.y) / v.k).toBeCloseTo(150);
		const w = zoomAt(v, 1.5, 600, 100, W, H);
		const before = { x: (600 - v.x) / v.k, y: (100 - v.y) / v.k };
		expect((600 - w.x) / w.k).toBeCloseTo(before.x);
		expect((100 - w.y) / w.k).toBeCloseTo(before.y);
	});
	it('never goes below the whole picture or above MAX_ZOOM', () => {
		expect(zoomAt(RESET, 0.5, 100, 100, W, H)).toEqual(RESET);
		expect(zoomAt({ k: 2, x: -300, y: -200 }, 0.1, 10, 10, W, H)).toEqual(RESET);
		expect(zoomAt(RESET, 1000, 400, 300, W, H).k).toBe(MAX_ZOOM);
	});
});

describe('clampPan', () => {
	it('keeps the picture covering the frame (no empty edge)', () => {
		expect(clampPan({ k: 2, x: 50, y: 50 }, W, H)).toEqual({ k: 2, x: 0, y: 0 });
		expect(clampPan({ k: 2, x: -5000, y: -5000 }, W, H)).toEqual({ k: 2, x: -W, y: -H });
		expect(clampPan({ k: 1, x: -20, y: 30 }, W, H)).toEqual(RESET);
	});
});

describe('panBy', () => {
	it('moves the picture with the pointer, inside the limits', () => {
		expect(panBy({ k: 3, x: -400, y: -300 }, 100, -50, W, H)).toEqual({ k: 3, x: -300, y: -350 });
		expect(panBy({ k: 3, x: -10, y: 0 }, 100, 0, W, H).x).toBe(0);
	});
});

describe('zoomTo', () => {
	it('zooms to a level around a point (double-click)', () => {
		const v = zoomTo(RESET, 2.5, 400, 300, W, H);
		expect(v.k).toBe(2.5);
		expect((400 - v.x) / v.k).toBeCloseTo(400);
	});
});

describe('wheelFactor', () => {
	it('zooms in on wheel up, out on wheel down, by the same step', () => {
		const up = wheelFactor(-100, 0);
		const down = wheelFactor(100, 0);
		expect(up).toBeGreaterThan(1);
		expect(down).toBeLessThan(1);
		expect(up * down).toBeCloseTo(1);
	});
	it('treats line and page deltas like pixel deltas of the same size, within limits', () => {
		expect(wheelFactor(-3, 1)).toBeCloseTo(wheelFactor(-48, 0));
		expect(wheelFactor(-10000, 0)).toBeLessThanOrEqual(2);
		expect(wheelFactor(10000, 0)).toBeGreaterThanOrEqual(0.5);
	});
});

describe('zoom cap', () => {
	it('zoomTo and zoomAt stop at the given maximum', () => {
		expect(zoomTo(RESET, 6, 400, 300, W, H, 2.5).k).toBe(2.5);
		expect(zoomAt(RESET, 10, 400, 300, W, H, 3).k).toBe(3);
	});
	it('pixelCap is 100% of the real pixels, between 1 and MAX_ZOOM', () => {
		expect(pixelCap(4096, 1024)).toBe(4);
		expect(pixelCap(1600, 1600)).toBe(1); // an old image stored small: no zoom past its pixels
		expect(pixelCap(900, 1600)).toBe(1);
		expect(pixelCap(100000, 1000)).toBe(MAX_ZOOM);
		expect(pixelCap(0, 1000)).toBe(MAX_ZOOM); // not loaded yet: no cap known
	});
});

describe('loupeView', () => {
	const img = { left: 100, top: 50, width: 400, height: 300 };
	it('centres the point under the pointer, magnified', () => {
		const l = loupeView(300, 200, img, img, 220, 2.5);
		// Pointer at the image centre: the window (the whole image here) is centred on the loupe.
		expect(l.win).toEqual({ x: 110 - 500, y: 110 - 375, w: 1000, h: 750 });
		expect(l.bg).toEqual({ x: 0, y: 0, w: 1000, h: 750 });
	});
	it('shows only the frame (the crop) of a larger image', () => {
		// The image is twice the frame: the frame shows its right half.
		const big = { left: -100, top: 50, width: 800, height: 300 };
		const l = loupeView(300, 200, big, img, 220, 2);
		expect(l.win).toEqual({ x: 110 - 400, y: 110 - 300, w: 800, h: 600 });
		// Inside the window the image starts 200 px left of the frame, times 2.
		expect(l.bg).toEqual({ x: -400, y: 0, w: 1600, h: 600 });
		// The image point under the pointer sits at the loupe centre.
		expect(l.win.x + l.bg.x + (300 - big.left) * 2).toBe(110);
	});
});

describe('pinchView', () => {
	it('keeps the image point under the starting midpoint under the current midpoint', () => {
		const from = { k: 2, x: -200, y: -100 };
		const m0 = { x: 300, y: 200 };
		const m1 = { x: 340, y: 230 }; // the fingers moved together
		const v = pinchView(from, m0, m1, 1.5, W, H, MAX_ZOOM);
		expect(v.k).toBe(3);
		const p0 = { x: (m0.x - from.x) / from.k, y: (m0.y - from.y) / from.k };
		expect((m1.x - v.x) / v.k).toBeCloseTo(p0.x);
		expect((m1.y - v.y) / v.k).toBeCloseTo(p0.y);
	});
	it('respects the cap and the frame', () => {
		expect(pinchView(RESET, { x: 10, y: 10 }, { x: 10, y: 10 }, 10, W, H, 2).k).toBe(2);
		expect(pinchView({ k: 2, x: -100, y: -100 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 0.2, W, H, MAX_ZOOM)).toEqual(RESET);
	});
});
