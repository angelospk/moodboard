import { describe, expect, it } from 'vitest';
import { clampPan, MAX_ZOOM, panBy, RESET, wheelFactor, zoomAt, zoomTo } from '../src/lib/zoom.js';

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
