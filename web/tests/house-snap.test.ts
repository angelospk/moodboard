// Slice B: snapping while drawing and dragging (src/lib/house/snap.ts).
import { describe, expect, it } from 'vitest';
import { pointAtLength, snap } from '../src/lib/house/snap';
import { emptyModel, type HouseModel, type Wall } from '../src/lib/house/model';

const wall = (id: string, points: Wall['points']): Wall => ({
	id, type: 'wall', name: '', material: 'plaster_white', points, height: 3, thickness: 0.25, base: 0
});
// W runs east along y = 0, V north along x = 6; they share the corner (6, 0).
const L: HouseModel = { ...emptyModel(), elements: [wall('W', [[0, 0], [6, 0]]), wall('V', [[6, 0], [6, 4]])] };
const lone: HouseModel = { ...emptyModel(), elements: [wall('W', [[0, 0], [6, 0]])] };

describe('snap', () => {
	it('a corner beats a wall axis, which beats the grid', () => {
		// (5.9, 0.1) is 0.1 from W's axis too, but the corner (6, 0) wins.
		expect(snap([5.9, 0.1], L, { grid: 0.5 })).toMatchObject({ point: [6, 0], kind: 'corner' });
		// Near W's axis, far from corners: projected onto the axis, not rounded to the grid.
		expect(snap([3.03, 0.02], L, { grid: 0.5 })).toEqual({ point: [3.03, 0], kind: 'axis', ref: 'W' });
		// Far from every wall: the grid.
		expect(snap([3.1, 2.2], L, { grid: 0.5 })).toEqual({ point: [3, 2], kind: 'grid' });
		// Excluded walls (the ones being dragged) give nothing.
		expect(snap([5.9, 0.1], L, { grid: 0.5, exclude: ['W', 'V'] })).toEqual({ point: [6, 0], kind: 'grid' });
		// Without W only V's corners are left: y aligns to their y = 0, x goes to the grid.
		expect(snap([3.03, 0.02], L, { grid: 0.5, exclude: ['W'] })).toEqual({ point: [3, 0], kind: 'align' });
	});

	it('snaps onto a wall face at ±thickness/2', () => {
		expect(snap([3.03, 0.2], L, { grid: 0.5 })).toEqual({ point: [3.03, 0.125], kind: 'face', ref: 'W' });
		expect(snap([3.03, -0.14], L, { grid: 0.5 })).toEqual({ point: [3.03, -0.125], kind: 'face', ref: 'W' });
		expect(snap([6.2, 2.03], L, { grid: 0.5 })).toEqual({ point: [6.125, 2.03], kind: 'face', ref: 'V' });
	});

	it('aligns x or y to another corner within radius', () => {
		// x within 0.1 of the corner x = 6, y rounded to the grid.
		expect(snap([6.1, 2.3], lone, { grid: 0.5 })).toEqual({ point: [6, 2.5], kind: 'align' });
		// y within 0.1 of the corner y = 0, x rounded to the grid; 1 m from the wall end, so no axis snap.
		expect(snap([-1.1, 0.1], lone, { grid: 0.5 })).toEqual({ point: [-1, 0], kind: 'align' });
		// Outside the radius: plain grid.
		expect(snap([6.4, 2.3], lone, { grid: 0.5 })).toEqual({ point: [6.5, 2.5], kind: 'grid' });
		expect(snap([6.1, 2.3], lone, { grid: 0.5, radius: 0.05 })).toEqual({ point: [6, 2.5], kind: 'grid' });
	});

	it('pointAtLength(last, cursor, 3.2) is exactly 3.2 m along the cursor direction', () => {
		const p = pointAtLength([1, 1], [4, 5], 3.2);
		expect(p[0]).toBeCloseTo(2.92, 9);
		expect(p[1]).toBeCloseTo(3.56, 9);
		expect(Math.hypot(p[0] - 1, p[1] - 1)).toBeCloseTo(3.2, 9);
		expect(pointAtLength([2, 3], [2, 3], 1.5)).toEqual([3.5, 3]);
		const q = pointAtLength([0, 0], [-0.1, 0], 2.75);
		expect(q[0]).toBeCloseTo(-2.75, 9);
		expect(q[1]).toBeCloseTo(0, 9);
	});
});
