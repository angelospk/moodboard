// Glue between the editor's pointer input and the pure drag/snap modules (src/lib/house/interaction.ts).
import { describe, expect, it } from 'vitest';
import { dragSnapper, dragStart, drawSnap, handleElevation, previewScope, typedLength } from '../src/lib/house/interaction';
import { handlesFor, type Handle } from '../src/lib/house/handles';
import { emptyModel, type Box, type HouseModel, type Item, type Opening, type Slab, type Wall } from '../src/lib/house/model';

const wall = (id: string, points: [number, number][], extra: Partial<Wall> = {}): Wall => ({
	id, type: 'wall', name: '', material: 'plaster_white', points, height: 3, thickness: 0.2, base: 0, ...extra
});
const win = (id: string, host: string, segment: number, offset: number): Opening => ({
	id, type: 'window', name: '', material: 'glass', host, segment, offset, width: 1, height: 1, sill: 0.9
});
const box: Box = { id: 'b', type: 'box', name: '', material: 'concrete', center: [1, 1], width: 2, length: 2, height: 2, base: 0.5, rotation: 0 };
const item: Item = { id: 'i', type: 'item', kind: 'sofa', name: '', material: 'plaster_warm', center: [5, 5], width: 2.2, length: 0.9, height: 0.85, base: 0, rotation: 0 };
const slab: Slab = { id: 's', type: 'slab', name: '', material: 'concrete', outline: [[0, 0], [4, 0], [4, 4]], elevation: 0.3, thickness: 0.2 };
const model = (...elements: HouseModel['elements']): HouseModel => ({ ...emptyModel(), elements });
const handle = (h: Partial<Handle> & Pick<Handle, 'kind'>): Handle => ({ element: 'a', index: 0, at: [0, 0], ...h });

describe('previewScope', () => {
	it('a dragged wall brings its openings and hides the same ids', () => {
		const a = wall('a', [[0, 0], [4, 0]]);
		const other = wall('c', [[10, 0], [14, 0]]);
		const m = model(a, win('o', 'a', 0, 2), other, box);
		const moved = model(wall('a', [[0, 0], [5, 0]]), win('o', 'a', 0, 2.5), other, box);
		const s = previewScope(m, moved, ['a', 'o']);
		expect(s.model.elements.map((e) => e.id).sort()).toEqual(['a', 'o']);
		expect(s.model.elements.find((e) => e.id === 'a')).toEqual(moved.elements[0]);
		expect([...s.hide].sort()).toEqual(['a', 'o']);
	});

	it('a rehosted opening shows both walls with all their openings', () => {
		const a = wall('a', [[0, 0], [4, 0]]);
		const c = wall('c', [[0, 1], [4, 1]]);
		const m = model(a, c, win('o', 'a', 0, 2), win('p', 'c', 0, 3), box);
		const moved = model(a, c, win('o', 'c', 0, 1), win('p', 'c', 0, 3), box);
		const s = previewScope(m, moved, ['o']);
		expect(s.model.elements.map((e) => e.id).sort()).toEqual(['a', 'c', 'o', 'p']);
		expect([...s.hide].sort()).toEqual(['a', 'c', 'o', 'p']);
	});

	it('a moved box is alone', () => {
		const m = model(wall('a', [[0, 0], [4, 0]]), box);
		const moved = model(wall('a', [[0, 0], [4, 0]]), { ...box, center: [2, 2] });
		const s = previewScope(m, moved, ['b']);
		expect(s.model.elements).toEqual([{ ...box, center: [2, 2] }]);
		expect([...s.hide]).toEqual(['b']);
	});
});

describe('handleElevation', () => {
	const w = wall('a', [[0, 0], [4, 0]], { base: 1 });
	it('wall base, slab top, top of a box or item, opening centre', () => {
		expect(handleElevation(w, model(w))).toBe(1);
		expect(handleElevation(slab, model(slab))).toBe(0.3);
		expect(handleElevation(box, model(box))).toBe(2.5);
		expect(handleElevation(item, model(item))).toBeCloseTo(0.85, 9);
		const o = win('o', 'a', 0, 2);
		expect(handleElevation(o, model(w, o))).toBeCloseTo(1 + 0.9 + 0.5, 9);
	});
});

describe('dragStart', () => {
	it('handles start at their own point; the body starts at the press on the grid', () => {
		expect(dragStart(handle({ kind: 'corner', at: [1.13, 2] }), [1.2, 2.1], 0.25)).toEqual([1.13, 2]);
		expect(dragStart(handle({ kind: 'mid', at: [2, 0] }), [2.1, 0.05], 0.25)).toEqual([2, 0]);
		expect(dragStart(handle({ kind: 'body', at: [2, 0] }), [2.13, 0.1], 0.25)).toEqual([2.25, 0]);
	});
});

describe('dragSnapper', () => {
	const a = wall('a', [[0, 0], [4, 0]]);
	const c = wall('c', [[0, 3], [4, 3]]);
	const m = model(a, c, win('o', 'a', 0, 2), box);
	it('a corner snaps to other walls, never to its own wall', () => {
		const s = dragSnapper(m, handle({ kind: 'corner', element: 'a', index: 1, at: [4, 0] }), 0.25)!;
		expect(s([4.05, 2.9])).toEqual([4, 3]); // the other wall's corner
		expect(s([0.07, 0.02])).toEqual([0, 0]); // own corner excluded: x aligned to the other wall's corner, y on the grid
		expect(s([1.13, 2.92])).toEqual([1.13, 2.9]); // the other wall's face (radius 0.15)
		expect(s([1.13, 2.7])).toEqual([1.25, 2.75]); // farther than 0.15 from any face: the grid
	});
	it('the body snaps to the grid only', () => {
		const s = dragSnapper(m, handle({ kind: 'body', element: 'a', index: -1 }), 0.25)!;
		expect(s([0.04, 2.97])).toEqual([0, 3]);
		expect(s([1.13, 2.92])).toEqual([1.25, 3]);
	});
	it('an opening and a rotate knob are not snapped', () => {
		expect(dragSnapper(m, handle({ kind: 'center', element: 'o', index: -1 }), 0.25)).toBeNull();
		expect(dragSnapper(m, handle({ kind: 'rotate', element: 'b', index: -1 }), 0.25)).toBeNull();
	});
	it('a placed centre snaps like a point', () => {
		const s = dragSnapper(m, handlesFor(box)[0], 0.25)!;
		expect(s([2.11, 1.9])).toEqual([2, 2]);
	});
});

describe('drawSnap', () => {
	const m = model(wall('a', [[0, 0], [4, 0]]));
	it('a draft corner within 0.3 wins (closing the shape), then the walls, then the grid', () => {
		expect(drawSnap([7.2, 5.8], m, [[7, 6], [10, 6]], 0.25)).toEqual([7, 6]);
		expect(drawSnap([3.2, 0.12], m, [], 0.25)).toEqual([3.2, 0.1]); // face of wall a (y = 0.1)
		expect(drawSnap([6.1, 2.4], m, [], 0.25)).toEqual([6, 2.5]);
	});
});

describe('typedLength', () => {
	it('reads metres with a dot or a comma; refuses zero, negatives and junk', () => {
		expect(typedLength('3.2')).toBe(3.2);
		expect(typedLength(' 3,25 ')).toBe(3.25);
		expect(typedLength('0')).toBeNull();
		expect(typedLength('-2')).toBeNull();
		expect(typedLength('abc')).toBeNull();
		expect(typedLength('')).toBeNull();
		expect(typedLength('20000')).toBeNull();
	});
});
