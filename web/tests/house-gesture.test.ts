// Slice E: edit handles (src/lib/house/handles.ts) and the drag session (src/lib/house/gesture.ts).
// The session tests inject a fake drag op, so they do not depend on slice A (drag.ts).
import { describe, expect, it, vi } from 'vitest';
import { handleAt, handlesFor, type Handle } from '../src/lib/house/handles';
import { DragSession } from '../src/lib/house/gesture';
import { emptyModel, type Box, type HouseModel, type Opening, type Slab, type Vec2, type Wall } from '../src/lib/house/model';

const wall: Wall = { id: 'w', type: 'wall', name: '', material: 'plaster_white', points: [[0, 0], [4, 0], [4, 3]], height: 3, thickness: 0.25, base: 0 };
const box: Box = { id: 'b', type: 'box', name: '', material: 'concrete', center: [1, 1], width: 2, length: 2, height: 2, base: 0, rotation: 0 };
/** 100 px per metre, plan y down the screen: enough for a hit test. */
const project = (p: Vec2): Vec2 => [p[0] * 100, p[1] * 100];

describe('handles', () => {
	it('handlesFor(wall) returns its corner, body and mid handles', () => {
		const hs = handlesFor(wall);
		expect(hs.filter((h) => h.kind === 'corner')).toEqual([
			{ element: 'w', kind: 'corner', index: 0, at: [0, 0] },
			{ element: 'w', kind: 'corner', index: 1, at: [4, 0] },
			{ element: 'w', kind: 'corner', index: 2, at: [4, 3] }
		]);
		expect(hs.filter((h) => h.kind === 'mid')).toEqual([
			{ element: 'w', kind: 'mid', index: 0, at: [2, 0] },
			{ element: 'w', kind: 'mid', index: 1, at: [4, 1.5] }
		]);
		const body = hs.filter((h) => h.kind === 'body');
		expect(body).toHaveLength(1);
		expect(body[0]).toMatchObject({ element: 'w', index: -1, path: wall.points });
		expect(body[0].at[0]).toBeCloseTo(8 / 3, 9);
		expect(body[0].at[1]).toBeCloseTo(1, 9);
		expect(hs).toHaveLength(6);

		// Box: centre and a rotate knob 0.5 m beyond its far edge (length / 2 + 0.5 along +y).
		expect(handlesFor(box)).toEqual([
			{ element: 'b', kind: 'center', index: -1, at: [1, 1] },
			{ element: 'b', kind: 'rotate', index: -1, at: [1, 2.5] }
		]);
		const turned = handlesFor({ ...box, rotation: 90 }).find((h) => h.kind === 'rotate')!;
		expect(turned.at[0]).toBeCloseTo(-0.5, 9);
		expect(turned.at[1]).toBeCloseTo(1, 9);

		const win: Opening = { id: 'o', type: 'window', name: '', material: 'glass', host: 'w', segment: 1, offset: 1, width: 1, height: 1, sill: 1 };
		expect(handlesFor(win, wall)).toEqual([{ element: 'o', kind: 'center', index: -1, at: [4, 1] }]);
		expect(handlesFor(win)).toEqual([]);

		const slab: Slab = { id: 's', type: 'slab', name: '', material: 'concrete', outline: [[0, 0], [2, 0], [2, 2]], elevation: 0, thickness: 0.2 };
		expect(handlesFor(slab).map((h) => [h.kind, h.index, h.at])).toEqual([['vertex', 0, [0, 0]], ['vertex', 1, [2, 0]], ['vertex', 2, [2, 2]]]);
	});

	it('handleAt picks the nearest handle within the radius (px by pointer type: mouse 8, pen 10, touch 22)', () => {
		const hs = handlesFor(wall);
		expect(handleAt(hs, [405, 3], project, 'mouse')).toMatchObject({ kind: 'corner', index: 1 });
		// 12 px from corner 1 and from the wall line: outside mouse 8 and pen 10, inside touch 22.
		expect(handleAt(hs, [412, 0], project, 'mouse')).toBeNull();
		expect(handleAt(hs, [412, 0], project, 'pen')).toBeNull();
		expect(handleAt(hs, [412, 0], project, 'touch')).toMatchObject({ kind: 'corner', index: 1 });
		// 9.5 px: pen yes, mouse no; an unknown pointer type uses the mouse radius.
		expect(handleAt(hs, [409.5, 0], project, 'pen')).toMatchObject({ kind: 'corner', index: 1 });
		expect(handleAt(hs, [409.5, 0], project, 'mouse')).toBeNull();
		expect(handleAt(hs, [409.5, 0], project, 'stylus')).toBeNull();
		// Nearest wins: the mid "+" at (200, 0), not the body under it.
		expect(handleAt(hs, [200, 4], project, 'mouse')).toMatchObject({ kind: 'mid', index: 0 });
		// On the wall line, away from point handles: the body.
		expect(handleAt(hs, [100, 5], project, 'mouse')).toMatchObject({ kind: 'body' });
		// Touch: corner 0 at 15 px beats the body at 2 px.
		expect(handleAt(hs, [15, 2], project, 'touch')).toMatchObject({ kind: 'corner', index: 0 });
	});
});

describe('drag session', () => {
	const model: HouseModel = { ...emptyModel(), elements: [box] };
	const handle: Handle = { element: 'b', kind: 'center', index: -1, at: [1, 1] };
	/** Fake drag op: puts the box centre at `to`. */
	const moveBox = (m: HouseModel, h: Handle, _start: Vec2, to: Vec2): HouseModel =>
		({ ...m, elements: m.elements.map((e) => (e.id === h.element ? { ...e, center: to } : e)) });

	it('a DragSession gives a preview model on move and never calls commit before end', () => {
		const commit = vi.fn();
		const before = structuredClone(model);
		const s = new DragSession({ model, handle, pointerId: 1, start: [1, 1], commit, apply: moveBox });
		const p1 = s.move(1, [2, 2]);
		const p2 = s.move(1, [3, 1]);
		expect(p1).toMatchObject({ invalid: false, affected: ['b'] });
		expect(p1!.model.elements[0]).toMatchObject({ center: [2, 2] });
		expect(p2!.model.elements[0]).toMatchObject({ center: [3, 1] });
		expect(commit).not.toHaveBeenCalled();
		expect(s.move(2, [9, 9])).toBeNull(); // another pointer's move is ignored
		expect(commit).not.toHaveBeenCalled();
		expect(model).toEqual(before);
		// The snap hook runs before the op.
		const snapped = new DragSession({ model, handle, pointerId: 1, start: [1, 1], commit, apply: moveBox, snap: ([x, y]) => [Math.round(x), Math.round(y)] });
		expect(snapped.move(1, [2.4, 2.6])!.model.elements[0]).toMatchObject({ center: [2, 3] });
	});

	it('end returns one model; cancel, or a second pointer, returns null', () => {
		const commit = vi.fn();
		const s = new DragSession({ model, handle, pointerId: 1, start: [1, 1], commit, apply: moveBox });
		s.move(1, [2, 2]);
		s.move(1, [3, 1]);
		expect(s.end(2)).toBeNull(); // not our pointer
		const out = s.end(1);
		expect(out!.elements[0]).toMatchObject({ center: [3, 1] });
		expect(commit).toHaveBeenCalledTimes(1);
		expect(commit).toHaveBeenCalledWith(out);
		expect(s.done).toBe(true);
		expect(s.end(1)).toBeNull();
		expect(commit).toHaveBeenCalledTimes(1);

		const c2 = vi.fn();
		const tap = new DragSession({ model, handle, pointerId: 1, start: [1, 1], commit: c2, apply: moveBox });
		expect(tap.end(1)).toBeNull(); // nothing moved
		const cancelled = new DragSession({ model, handle, pointerId: 1, start: [1, 1], commit: c2, apply: moveBox });
		cancelled.move(1, [2, 2]);
		expect(cancelled.cancel()).toBeNull();
		expect(cancelled.done).toBe(true);
		expect(cancelled.move(1, [3, 3])).toBeNull();
		expect(cancelled.end(1)).toBeNull();
		const pinch = new DragSession({ model, handle, pointerId: 1, start: [1, 1], commit: c2, apply: moveBox });
		pinch.move(1, [2, 2]);
		pinch.pointerDown(1); // same pointer: ignored
		expect(pinch.done).toBe(false);
		pinch.pointerDown(7); // second finger
		expect(pinch.done).toBe(true);
		expect(pinch.end(1)).toBeNull();
		expect(c2).not.toHaveBeenCalled();
	});

	it('when a move would hide an opening, the preview is marked invalid', () => {
		const w: Wall = { id: 'w', type: 'wall', name: '', material: 'concrete', points: [[0, 0], [6, 0]], height: 3, thickness: 0.25, base: 0 };
		const o: Opening = { id: 'o', type: 'window', name: '', material: 'glass', host: 'w', segment: 0, offset: 4, width: 1.2, height: 1.4, sill: 0.9 };
		const m: HouseModel = { ...emptyModel(), elements: [w, o] };
		const corner: Handle = { element: 'w', kind: 'corner', index: 1, at: [6, 0] };
		/** Fake op: moves wall point 1, leaves the window where it is. */
		const movePoint = (mm: HouseModel, _h: Handle, _s: Vec2, to: Vec2): HouseModel =>
			({ ...mm, elements: mm.elements.map((e) => (e.type === 'wall' ? { ...e, points: [e.points[0], to] } : e)) });
		const commit = vi.fn();
		const s = new DragSession({ model: m, handle: corner, pointerId: 1, start: [6, 0], commit, apply: movePoint });
		expect(s.move(1, [8, 0])).toMatchObject({ invalid: false, affected: ['w'] });
		// 3 m wall: the window at 4 m no longer fits, so its hole would vanish.
		const bad = s.move(1, [3, 0])!;
		expect(bad.invalid).toBe(true);
		expect((bad.model.elements[0] as Wall).points).toEqual([[0, 0], [3, 0]]);
		expect(s.end(1)).toBeNull();
		expect(commit).not.toHaveBeenCalled();

		// An op that refuses the move (null) is invalid too; the preview keeps the last valid model.
		const refuse = (mm: HouseModel, h: Handle, st: Vec2, to: Vec2) => (to[0] < 0 ? null : movePoint(mm, h, st, to));
		const r = new DragSession({ model: m, handle: corner, pointerId: 1, start: [6, 0], commit, apply: refuse });
		r.move(1, [7, 0]);
		const no = r.move(1, [-1, 0])!;
		expect(no.invalid).toBe(true);
		expect((no.model.elements[0] as Wall).points).toEqual([[0, 0], [7, 0]]);
	});
});
