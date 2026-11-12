import { describe, expect, it } from 'vitest';
import { bboxOf, regionFromStroke, simplify, svgPoints } from '../src/lib/shape';

describe('shape', () => {
	it('bboxOf gives the enclosing box', () => {
		expect(bboxOf([[0.2, 0.3], [0.6, 0.1], [0.4, 0.9]])).toEqual({ x: 0.2, y: 0.1, w: 0.4, h: 0.8 });
	});

	it('simplify drops points on a straight line and keeps corners', () => {
		const line: [number, number][] = [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]];
		expect(simplify(line, 0.01)).toEqual([[0, 0], [1, 1]]);
		const corner: [number, number][] = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1]];
		expect(simplify(corner, 0.01)).toEqual([[0, 0], [1, 0], [1, 1]]);
	});

	it('regionFromStroke makes a region with points, box and empty note', () => {
		const stroke: [number, number][] = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5], [0.1, 0.12]];
		const r = regionFromStroke(stroke)!;
		expect(r.note).toBe('');
		expect(r.rating).toBeNull();
		expect(r.points!.length).toBeGreaterThanOrEqual(3);
		expect(r.x).toBeCloseTo(0.1);
		expect(r.w).toBeCloseTo(0.4);
	});

	it('regionFromStroke rejects a tap or a tiny scribble', () => {
		expect(regionFromStroke([[0.5, 0.5], [0.501, 0.5]])).toBeNull();
		expect(regionFromStroke([[0.5, 0.5], [0.51, 0.51], [0.5, 0.52]])).toBeNull();
	});

	it('regionFromStroke caps the point count and clamps to 0..1', () => {
		const stroke: [number, number][] = Array.from({ length: 2000 }, (_, i) => [
			0.5 + 0.4 * Math.cos(i / 20) * (i % 2 ? 1.5 : 1),
			0.5 + 0.4 * Math.sin(i / 20)
		]);
		const r = regionFromStroke(stroke)!;
		expect(r.points!.length).toBeLessThanOrEqual(120);
		for (const [x, y] of r.points!) {
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(1);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(1);
		}
	});

	it('svgPoints formats for a 0..1 viewBox', () => {
		expect(svgPoints([[0.1, 0.2], [0.3, 0.4]])).toBe('0.1,0.2 0.3,0.4');
	});
});
