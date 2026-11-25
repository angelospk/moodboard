// Slice A: drag operations (src/lib/house/drag.ts). Pure functions on the house model.
import { describe, expect, it } from 'vitest';
import { insertWallPoint, moveOpening, movePlaced, moveSlabPoint, moveWall, moveWallPoint, rotatePlaced } from '../src/lib/house/drag';
import { emptyModel, type Element, type HouseModel, type Opening, type Slab, type Wall } from '../src/lib/house/model';

const wall = (id: string, points: Wall['points'], over: Partial<Wall> = {}): Wall => ({
	id, type: 'wall', name: '', material: 'plaster_white', points, height: 3, thickness: 0.25, base: 0, ...over
});
const win = (id: string, host: string, segment: number, offset: number, over: Partial<Opening> = {}): Opening => ({
	id, type: 'window', name: '', material: 'glass', host, segment, offset, width: 0.6, height: 1.2, sill: 0.9, ...over
});
const model = (...elements: Element[]): HouseModel => ({ ...emptyModel(), elements });
const byId = (m: HouseModel, id: string) => m.elements.find((e) => e.id === id)!;

describe('drag ops', () => {
	it('moveWallPoint keeps openings at the same fraction of the segment', () => {
		const m = model(wall('w', [[0, 0], [4, 0], [4, 3]]), win('a', 'w', 0, 1), win('b', 'w', 1, 1.5));
		const out = moveWallPoint(m, 'w', 1, [8, 0]);
		expect((byId(out, 'w') as Wall).points).toEqual([[0, 0], [8, 0], [4, 3]]);
		// Segment 0: 4 m → 8 m, fraction 0.25. Segment 1: 3 m → 5 m, fraction 0.5.
		expect((byId(out, 'a') as Opening).offset).toBeCloseTo(2, 9);
		expect((byId(out, 'b') as Opening).offset).toBeCloseTo(2.5, 9);
		expect((byId(out, 'a') as Opening).segment).toBe(0);
	});

	it('moving a shared corner moves the joined wall', () => {
		const m = model(wall('A', [[0, 0], [4, 0]]), wall('B', [[4, 0], [4, 3]]), wall('C', [[10, 0], [10, 3]]), win('o', 'B', 0, 1.5));
		const out = moveWallPoint(m, 'A', 1, [4, -1]);
		expect((byId(out, 'A') as Wall).points).toEqual([[0, 0], [4, -1]]);
		expect((byId(out, 'B') as Wall).points).toEqual([[4, -1], [4, 3]]);
		expect((byId(out, 'C') as Wall).points).toEqual([[10, 0], [10, 3]]);
		// B: 3 m → 4 m, the window stays at half its length.
		expect((byId(out, 'o') as Opening).offset).toBeCloseTo(2, 9);
	});

	it('moving point 0 of a closed loop moves the last point too', () => {
		const loop: Wall['points'] = [[0, 0], [4, 0], [4, 3], [0, 3], [0, 0]];
		const m = model(wall('L', loop));
		expect((byId(moveWallPoint(m, 'L', 0, [-1, -1]), 'L') as Wall).points).toEqual([[-1, -1], [4, 0], [4, 3], [0, 3], [-1, -1]]);
		expect((byId(moveWallPoint(m, 'L', 4, [-1, -1]), 'L') as Wall).points).toEqual([[-1, -1], [4, 0], [4, 3], [0, 3], [-1, -1]]);
	});

	it('moveWall translates points, openings unchanged', () => {
		const m = model(wall('w', [[0, 0], [4, 0], [4, 3]]), win('a', 'w', 1, 1.5));
		const out = moveWall(m, 'w', [1, 2]);
		expect((byId(out, 'w') as Wall).points).toEqual([[1, 2], [5, 2], [5, 5]]);
		expect(byId(out, 'a')).toEqual(byId(m, 'a'));
		// A joined wall stretches: its shared end follows, its other end stays.
		const j = model(wall('A', [[0, 0], [4, 0]]), wall('B', [[4, 0], [4, 3]]));
		const jo = moveWall(j, 'A', [0, -1]);
		expect((byId(jo, 'A') as Wall).points).toEqual([[0, -1], [4, -1]]);
		expect((byId(jo, 'B') as Wall).points).toEqual([[4, -1], [4, 3]]);
	});

	it('insertWallPoint renumbers later openings and keeps each on the half holding its centre', () => {
		const m = model(wall('w', [[0, 0], [6, 0], [6, 4]]), win('o1', 'w', 0, 1), win('o2', 'w', 0, 4.5), win('o3', 'w', 1, 2));
		const out = insertWallPoint(m, 'w', 0, [3, 0]);
		expect((byId(out, 'w') as Wall).points).toEqual([[0, 0], [3, 0], [6, 0], [6, 4]]);
		expect(byId(out, 'o1')).toMatchObject({ segment: 0, offset: 1 });
		expect(byId(out, 'o2')).toMatchObject({ segment: 1 });
		expect((byId(out, 'o2') as Opening).offset).toBeCloseTo(1.5, 9);
		expect(byId(out, 'o3')).toMatchObject({ segment: 2, offset: 2 });
	});

	it('moveOpening slides on its host and rehosts to a wall within 0.8 m', () => {
		const m = model(wall('A', [[0, 0], [6, 0]]), wall('B', [[10, 0], [10, 5]]), win('o', 'A', 0, 2));
		const slid = moveOpening(m, 'o', [4.5, 0.3]);
		expect(byId(slid, 'o')).toMatchObject({ host: 'A', segment: 0 });
		expect((byId(slid, 'o') as Opening).offset).toBeCloseTo(4.5, 9);
		const re = moveOpening(m, 'o', [10.5, 2]);
		expect(byId(re, 'o')).toMatchObject({ host: 'B', segment: 0 });
		expect((byId(re, 'o') as Opening).offset).toBeCloseTo(2, 9);
		// B is 1.0 m away: too far, so the opening stays on A at the clamped end of the segment.
		const far = moveOpening(m, 'o', [11, 2]);
		expect(byId(far, 'o')).toMatchObject({ host: 'A', segment: 0 });
		expect((byId(far, 'o') as Opening).offset).toBeCloseTo(6, 9);
	});

	it('movePlaced/rotatePlaced snap rotation to 15°', () => {
		const m = model(
			{ id: 'b', type: 'box', name: '', material: 'concrete', center: [1, 1], width: 2, length: 2, height: 2, base: 0, rotation: 30 },
			{ id: 'i', type: 'item', kind: 'sofa', name: '', material: 'plaster_warm', center: [0, 0], width: 2.2, length: 0.9, height: 0.85, base: 0, rotation: 0 }
		);
		expect(byId(movePlaced(m, 'b', [5, -2]), 'b')).toMatchObject({ center: [5, -2], rotation: 30, width: 2 });
		expect(byId(movePlaced(m, 'i', [3, 4]), 'i')).toMatchObject({ center: [3, 4], kind: 'sofa' });
		expect(byId(rotatePlaced(m, 'i', 37), 'i')).toMatchObject({ rotation: 30 });
		expect(byId(rotatePlaced(m, 'i', -10), 'i')).toMatchObject({ rotation: 345 });
		expect(byId(rotatePlaced(m, 'i', 353), 'i')).toMatchObject({ rotation: 0 });
		expect(byId(rotatePlaced(m, 'b', 100), 'b')).toMatchObject({ rotation: 105 });
	});

	it('moveSlabPoint refuses a self-crossing outline (returns null)', () => {
		const slab: Slab = { id: 's', type: 'slab', name: '', material: 'concrete', outline: [[0, 0], [4, 0], [4, 4], [0, 4]], elevation: 0, thickness: 0.2 };
		const m = model(slab);
		expect(moveSlabPoint(m, 's', 1, [4, 5])).toBeNull();
		const ok = moveSlabPoint(m, 's', 2, [5, 5]);
		expect(ok).not.toBeNull();
		expect((byId(ok!, 's') as Slab).outline).toEqual([[0, 0], [4, 0], [5, 5], [0, 4]]);
	});

	it('every op is pure (input deep-equal after)', () => {
		const slab: Slab = { id: 's', type: 'slab', name: '', material: 'concrete', outline: [[0, 0], [4, 0], [4, 4], [0, 4]], elevation: 0, thickness: 0.2 };
		const m = model(
			wall('A', [[0, 0], [4, 0], [4, 3]]),
			wall('B', [[4, 3], [0, 3]]),
			win('o', 'A', 0, 2),
			slab,
			{ id: 'b', type: 'box', name: '', material: 'concrete', center: [1, 1], width: 2, length: 2, height: 2, base: 0, rotation: 0 }
		);
		const before = structuredClone(m);
		moveWallPoint(m, 'A', 2, [5, 4]);
		moveWall(m, 'A', [1, 1]);
		insertWallPoint(m, 'A', 0, [2, 0]);
		moveOpening(m, 'o', [4.2, 1]);
		movePlaced(m, 'b', [2, 2]);
		rotatePlaced(m, 'b', 45);
		moveSlabPoint(m, 's', 0, [-1, -1]);
		moveSlabPoint(m, 's', 1, [4, 5]);
		expect(m).toEqual(before);
		// An unknown id leaves the model as it was.
		expect(moveWallPoint(m, 'nope', 0, [1, 1])).toEqual(before);
	});
});
