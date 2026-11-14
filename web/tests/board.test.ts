import { describe, expect, it } from 'vitest';
import { ZONE_GAP, layoutTargets, sameLayout, separateFrom, viewerList, zoneBox, type CardNode, type Rect } from '../src/routes/map/board';
import type { Inspiration } from '../src/lib/types';

const overlaps = (a: Rect, b: Rect, gap = ZONE_GAP) =>
	a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
const moved = (r: Rect, d: { dx: number; dy: number }): Rect => ({ ...r, x: r.x + d.dx, y: r.y + d.dy });

describe('separateFrom', () => {
	it('does not move a box that keeps the gap from the others', () => {
		const box = { x: 0, y: 0, w: 100, h: 100 };
		expect(separateFrom(box, [{ x: 100 + ZONE_GAP, y: 0, w: 100, h: 100 }])).toEqual({ dx: 0, dy: 0 });
		expect(separateFrom(box, [])).toEqual({ dx: 0, dy: 0 });
	});

	it('pushes out along the shortest way', () => {
		const other = { x: 0, y: 0, w: 200, h: 200 };
		// Overlaps the right edge of `other` by 20px: moving right is the shortest way.
		const box = { x: 180, y: 0, w: 100, h: 200 };
		const d = separateFrom(box, [other]);
		expect(d.dy).toBe(0);
		expect(d.dx).toBe(20 + ZONE_GAP);
		expect(overlaps(moved(box, d), other)).toBe(false);
	});

	it('does not push into a third box when another way is free', () => {
		const a = { x: 0, y: 0, w: 200, h: 200 };
		// `c` sits right where the shortest way (right) would land.
		const c = { x: 200 + ZONE_GAP, y: 0, w: 200, h: 200 };
		const box = { x: 180, y: 10, w: 100, h: 180 };
		const d = separateFrom(box, [a, c]);
		const out = moved(box, d);
		expect(overlaps(out, a)).toBe(false);
		expect(overlaps(out, c)).toBe(false);
	});

	it('never returns a position that still overlaps when the ways are blocked', () => {
		// A box in a cage of obstacles: every shortest way lands on another obstacle.
		const box = { x: 90, y: 40, w: 20, h: 20 };
		const others = [
			{ x: 0, y: -100, w: 100, h: 300 },
			{ x: 110, y: -100, w: 100, h: 300 },
			{ x: -100, y: -100, w: 100, h: 300 },
			{ x: 210, y: -100, w: 100, h: 300 },
			{ x: -100, y: -200, w: 410, h: 100 },
			{ x: -100, y: 200, w: 410, h: 100 }
		];
		const out = moved(box, separateFrom(box, others));
		for (const o of others) expect(overlaps(out, o)).toBe(false);
	});

	it('handles a box fully inside another', () => {
		const other = { x: 0, y: 0, w: 400, h: 400 };
		const box = { x: 150, y: 150, w: 100, h: 100 };
		const d = separateFrom(box, [other]);
		expect(overlaps(moved(box, d), other)).toBe(false);
	});
});

describe('layoutTargets with a zone the user moved', () => {
	const node = (id: string, zone: string, x: number, y: number, pinned: boolean): CardNode =>
		({ id, zone, item: {} as CardNode['item'], w: 100, h: 80, x, y, fx: pinned ? x : null, fy: pinned ? y : null }) as CardNode;

	it('keeps free zones off a fully pinned zone', () => {
		// Pinned zone "a" sits where the free layout would start (the origin).
		const a = [node('i:1', 'a', -60, 0, true), node('i:2', 'a', 60, 0, true)];
		const b = [node('i:3', 'b', 0, 0, false), node('i:4', 'b', 0, 0, false), node('i:5', 'b', 0, 0, false)];
		const targets = layoutTargets(
			[
				{ key: 'a', nodes: a },
				{ key: 'b', nodes: b }
			],
			1.6
		);
		const placed = b.map((n) => ({ ...n, x: targets.get(n.id)!.x, y: targets.get(n.id)!.y }));
		const boxA = zoneBox(a)!;
		const boxB = zoneBox(placed)!;
		expect(overlaps(boxA, boxB, 0)).toBe(false);
	});

	it('keeps the free cards of a mostly pinned zone off another pinned zone', () => {
		const a = [node('i:1', 'a', 0, 100, true)];
		const b = [node('i:2', 'b', 0, 0, true), node('i:3', 'b', 0, 0, false)];
		const targets = layoutTargets(
			[
				{ key: 'a', nodes: a },
				{ key: 'b', nodes: b }
			],
			1.6
		);
		const free = { ...b[1], x: targets.get('i:3')!.x, y: targets.get('i:3')!.y };
		const box = { x: free.x! - free.w / 2, y: free.y! - free.h / 2, w: free.w, h: free.h };
		expect(overlaps(box, zoneBox(a)!, 0)).toBe(false);
	});
});

describe('viewerList', () => {
	const it3 = (id: string, tags: string[]) => ({ id, tags }) as unknown as Inspiration;
	const all = [it3('1', ['entry', 'wood']), it3('2', ['wood']), it3('3', []), it3('4', ['x', 'entry'])];

	it('keeps every image that has the tag, first or not, in board order', () => {
		expect(viewerList(all, 'entry').map((i) => i.id)).toEqual(['1', '4']);
	});

	it('null means every image', () => {
		expect(viewerList(all, null)).toBe(all);
	});
});

describe('sameLayout', () => {
	const row = (id: string, tags: string[]) => ({ id, tags }) as unknown as Inspiration;
	const old = new Map([
		['i:1', { zone: 'a' }],
		['i:2', { zone: null }]
	]) as unknown as Map<string, CardNode>;

	it('is true when only row fields change', () => {
		expect(sameLayout(old, [row('1', ['a', 'b']), row('2', [])])).toBe(true);
	});

	it('is false when a card changes zone, appears or goes', () => {
		expect(sameLayout(old, [row('1', ['b', 'a']), row('2', [])])).toBe(false);
		expect(sameLayout(old, [row('1', ['a'])])).toBe(false);
		expect(sameLayout(old, [row('1', ['a']), row('3', [])])).toBe(false);
	});
});
