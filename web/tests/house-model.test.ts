// The house model of the 3D editor: snapping, openings on walls, wall faces, loading stored JSON.
import { describe, expect, it } from 'vitest';
import {
	emptyModel,
	fitOpening,
	nearestOnWall,
	parseModel,
	removeElement,
	segments,
	snapAngle,
	snapPoint,
	wallFace,
	type Opening,
	type Wall
} from '../src/lib/house/model';
import { material, MATERIALS } from '../src/lib/house/materials';

const wall = (over: Partial<Wall> = {}): Wall => ({
	id: 'w1', type: 'wall', name: '', material: 'plaster_white', points: [[0, 0], [5, 0], [5, 4]],
	height: 3, thickness: 0.25, base: 0, ...over
});
const win = (over: Partial<Opening> = {}): Opening => ({
	id: 'o1', type: 'window', name: '', material: 'glass', host: 'w1', segment: 0, offset: 2.5,
	width: 1.2, height: 1.4, sill: 0.9, ...over
});

describe('snapping', () => {
	it('rounds to the grid', () => {
		expect(snapPoint([1.12, -0.26], 0.25)).toEqual([1, -0.25]);
		expect(snapPoint([-0.1, 0.1], 0.5)).toEqual([0, 0]);
		expect(Object.is(snapPoint([-0.1, 0], 0.5)[0], -0)).toBe(false);
	});
	it('a wall corner within the radius wins over the grid', () => {
		expect(snapPoint([5.13, 0.1], 0.5, [[5.1, 0.05]], 0.3)).toEqual([5.1, 0.05]);
		expect(snapPoint([6, 0], 0.5, [[5.1, 0.05]], 0.3)).toEqual([6, 0]);
	});
	it('snaps the angle to 15° steps and keeps the length', () => {
		const p = snapAngle([0, 0], [4, 0.3]);
		expect(p).toEqual([Math.hypot(4, 0.3), 0].map((v) => Math.round(v * 1e6) / 1e6));
		const q = snapAngle([1, 1], [2, 2.1]);
		expect(q[0] - 1).toBeCloseTo(q[1] - 1, 5); // 45°
	});
});

describe('walls and openings', () => {
	it('splits a polyline into segments with length and direction', () => {
		const s = segments(wall());
		expect(s).toHaveLength(2);
		expect(s[0]).toMatchObject({ index: 0, length: 5, dir: [1, 0] });
		expect(s[1]).toMatchObject({ index: 1, length: 4, dir: [0, 1] });
	});
	it('finds the nearest point on a wall', () => {
		expect(nearestOnWall(wall(), [2, 0.4])).toEqual({ segment: 0, offset: 2, distance: 0.4 });
		expect(nearestOnWall(wall(), [5.3, 3])).toMatchObject({ segment: 1, offset: 3 });
	});
	it('keeps an opening inside its segment and the wall height', () => {
		const w = wall();
		expect(fitOpening(win({ offset: 0 }), w).offset).toBeCloseTo(0.65);
		expect(fitOpening(win({ offset: 9 }), w).offset).toBeCloseTo(4.35);
		expect(fitOpening(win({ width: 20 }), w).width).toBeCloseTo(4.9);
		const tall = fitOpening(win({ sill: 2, height: 5 }), w);
		expect(tall.sill + tall.height).toBeLessThanOrEqual(3);
		expect(fitOpening(win({ type: 'door', sill: 1 }), w).sill).toBe(0);
	});
	it('a window is a hole and a door is a notch in the wall face', () => {
		const face = wallFace(5, 3, [
			{ type: 'window', offset: 3.5, width: 1, height: 1, sill: 1 },
			{ type: 'door', offset: 1, width: 0.9, height: 2.1, sill: 0 }
		]);
		expect(face.holes).toEqual([[[3, 1], [4, 1], [4, 2], [3, 2]]]);
		expect(face.outline).toEqual([[0, 0], [0.55, 0], [0.55, 2.1], [1.45, 2.1], [1.45, 0], [5, 0], [5, 3], [0, 3]]);
	});
	it('skips an opening that overlaps another or leaves the segment', () => {
		const face = wallFace(5, 3, [
			{ type: 'window', offset: 2, width: 1, height: 1, sill: 1 },
			{ type: 'window', offset: 2.4, width: 1, height: 1, sill: 1 },
			{ type: 'window', offset: 4.9, width: 1, height: 1, sill: 1 }
		]);
		expect(face.holes).toHaveLength(1);
	});
	it('removing a wall removes its openings', () => {
		const m = { ...emptyModel(), elements: [wall(), win(), win({ id: 'o2', type: 'door' })] };
		expect(removeElement(m, 'w1').elements).toEqual([]);
		expect(removeElement(m, 'o1').elements.map((e) => e.id)).toEqual(['w1', 'o2']);
	});
});

describe('parseModel', () => {
	it('keeps a valid model as it is', () => {
		const m = { ...emptyModel(), elements: [wall(), win()] };
		expect(parseModel(JSON.parse(JSON.stringify(m)))).toEqual(m);
	});
	it('never throws and drops broken elements', () => {
		for (const raw of [null, 3, 'x', {}, { elements: 'no' }, { elements: [null, 1, { type: 'rocket' }] }]) {
			expect(parseModel(raw).elements).toEqual([]);
		}
		const m = parseModel({ elements: [
			{ id: 'a', type: 'wall', points: [[0, 0]] },
			{ id: 'b', type: 'slab', outline: [[0, 0], [1, 0]] },
			{ id: 'c', type: 'box', center: ['x', 0] },
			{ id: 'd', type: 'window', host: 'nope', segment: 0, offset: 1 }
		] });
		expect(m.elements).toEqual([]);
	});
	it('clamps numbers, fills defaults and fixes duplicate ids', () => {
		const m = parseModel({ elements: [
			{ id: 'w', type: 'wall', points: [[0, 0], [3, 0]], height: -5, thickness: 'thick' },
			{ id: 'w', type: 'pool', center: [1, 2] }
		] });
		expect(m.elements[0]).toMatchObject({ height: 0.1, thickness: 0.25, material: 'plaster_white', base: 0 });
		expect(m.elements[1]).toMatchObject({ type: 'pool', width: 4, length: 8, depth: 1.5, material: 'pool_water' });
		expect(m.elements[1].id).not.toBe('w');
	});
	it('drops an opening on a segment its wall does not have', () => {
		const m = parseModel({ elements: [wall({ points: [[0, 0], [4, 0]] }), win({ segment: 1 })] });
		expect(m.elements.map((e) => e.type)).toEqual(['wall']);
	});
});

describe('materials', () => {
	it('ids are unique, colours are hex, the library covers the basics', () => {
		const ids = MATERIALS.map((m) => m.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const m of MATERIALS) expect(m.color).toMatch(/^#[0-9a-f]{6}$/);
		for (const id of ['plaster_white', 'concrete', 'glass', 'wood_oak', 'pool_water', 'roof_tile']) expect(ids).toContain(id);
		expect(material('unknown').id).toBe('plaster_white');
	});
});
