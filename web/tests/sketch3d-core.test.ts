import { describe, expect, it } from 'vitest';
import { newDoc, parseSketch, PLANES, BUDGET, type SketchDoc } from '../src/lib/sketch3d/doc.js';
import { toWorld, toLocal, normal, planeHit, heightAlong, offsetPolygon, area, isSimple, type V2 } from '../src/lib/sketch3d/geom.js';
import { recognize } from '../src/lib/sketch3d/recognize.js';
import { volumeMesh } from '../src/lib/sketch3d/mesh.js';
import { commit, undo, redo, current } from '../src/lib/sketch3d/edit.js';
import { PenGate } from '../src/lib/sketch3d/input.js';
import { replay } from '../src/lib/sketch3d/ops.js';

const close = (a: number[], b: number[], eps = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) < eps);
const plane = (id: string) => PLANES.find((p) => p.id === id)!;

describe('doc', () => {
	const withEls = (els: [string, unknown][]): unknown => {
		const d = newDoc('d1', 'Test');
		d.variants[0].ops.push({ id: 'o1', label: 'x', author: 'user', t: 1, ch: els.map(([id, el]) => ({ id, el })) } as never);
		return JSON.parse(JSON.stringify(d));
	};
	const rect: V2[] = [[0, 0], [4, 0], [4, 3], [0, 3]];

	it('a new document survives a JSON round trip through the gate', () => {
		const d = newDoc('d1', 'Σπίτι');
		expect(parseSketch(JSON.parse(JSON.stringify(d)))).toEqual(d);
		expect(d.planes.map((p) => p.id)).toEqual(['ground', 'front', 'side']);
		expect(d.current).toBe(d.variants[0].id);
	});
	it('accepts valid strokes and volumes', () => {
		const ok = withEls([
			['s1', { type: 'stroke', plane: 'ground', pts: rect, closed: true, shape: 'rect' }],
			['v1', { type: 'volume', plane: 'front', base: rect, h: 3, wall: 0.25, mat: 'plaster', name: 'Όγκος 1' }]
		]);
		expect(() => parseSketch(ok)).not.toThrow();
	});
	it.each([
		['wrong schema', (d: SketchDoc) => ((d as { schema: string }).schema = 'sketch3d/9')],
		['missing current variant', (d: SketchDoc) => (d.current = 'nope')],
		['duplicate plane id', (d: SketchDoc) => d.planes.push({ ...d.planes[0] })],
		['non-finite plane axis', (d: SketchDoc) => (d.planes[0].u = [NaN, 0, 0])]
	])('rejects %s', (_n, mutate) => {
		const d = newDoc('d1', 'x');
		mutate(d);
		expect(() => parseSketch(JSON.parse(JSON.stringify(d, (_k, v) => (Number.isNaN(v) ? 'NaN' : v))))).toThrow();
	});
	it.each([
		['unknown type', { type: 'blob' }],
		['unknown plane', { type: 'stroke', plane: 'mars', pts: rect, closed: true, shape: 'rect' }],
		['a point out of bounds', { type: 'stroke', plane: 'ground', pts: [[0, 0], [500, 0]], closed: false, shape: 'line' }],
		['a non-number point', { type: 'stroke', plane: 'ground', pts: [[0, 0], ['1', 0]], closed: false, shape: 'line' }],
		['one point', { type: 'stroke', plane: 'ground', pts: [[0, 0]], closed: false, shape: 'line' }],
		['zero height', { type: 'volume', plane: 'ground', base: rect, h: 0, wall: null, mat: 'plaster', name: 'v' }],
		['wall too thick', { type: 'volume', plane: 'ground', base: rect, h: 3, wall: 9, mat: 'plaster', name: 'v' }],
		['unknown material', { type: 'volume', plane: 'ground', base: rect, h: 3, wall: null, mat: 'gold', name: 'v' }],
		['extra field', { type: 'stroke', plane: 'ground', pts: rect, closed: true, shape: 'rect', evil: 1 }],
		['a closed stroke with two points', { type: 'stroke', plane: 'ground', pts: [[0, 0], [1, 0]], closed: true, shape: 'free' }],
		['a self-crossing volume base', { type: 'volume', plane: 'ground', base: [[0, 0], [2, 2], [2, 0], [0, 2]], h: 3, wall: null, mat: 'plaster', name: 'v' }],
		['a collinear volume base', { type: 'volume', plane: 'ground', base: [[0, 0], [1, 0], [2, 0]], h: 3, wall: null, mat: 'plaster', name: 'v' }]
	])('rejects an element with %s', (_n, el) => {
		expect(() => parseSketch(withEls([['e1', el]]))).toThrow();
	});
	it('rejects duplicate op ids in a variant', () => {
		const d = withEls([]) as { variants: { ops: unknown[] }[] };
		d.variants[0].ops.push({ ...(d.variants[0].ops[0] as object) });
		expect(() => parseSketch(d)).toThrow();
	});
	it('rejects merge bookkeeping on an op that is not a merge', () => {
		const d = withEls([['e', { type: 'stroke', plane: 'ground', pts: rect, closed: true, shape: 'rect' }]]) as { variants: { ops: { ch: { from?: string }[]; merged?: string[] }[] }[] };
		d.variants[0].ops[0].ch[0].from = 'x';
		expect(() => parseSketch(d)).toThrow();
		delete d.variants[0].ops[0].ch[0].from;
		d.variants[0].ops[0].merged = ['x'];
		expect(() => parseSketch(d)).toThrow();
	});
	it('counts points against one budget for the whole document', () => {
		const d = withEls([
			['a', { type: 'stroke', plane: 'ground', pts: rect, closed: true, shape: 'rect' }],
			['b', { type: 'stroke', plane: 'ground', pts: rect, closed: true, shape: 'rect' }]
		]);
		expect(() => parseSketch(d, { ...BUDGET, points: 8 })).not.toThrow();
		expect(() => parseSketch(d, { ...BUDGET, points: 7 })).toThrow();
	});
	it('charges every copy of an op shared by forked variants, in any key order, and rejects a different op under a shared id', () => {
		const d = withEls([['a', { type: 'stroke', plane: 'ground', pts: rect, closed: true, shape: 'rect' }]]) as { variants: { id: string; name: string; ops: Record<string, unknown>[] }[] };
		for (let k = 0; k < 5; k++) d.variants.push({ id: `v${k}`, name: `V${k}`, ops: structuredClone(d.variants[0].ops) });
		expect(() => parseSketch(d, { ...BUDGET, points: 24, ops: 6 })).not.toThrow();
		expect(() => parseSketch(d, { ...BUDGET, points: 23 })).toThrow();
		expect(() => parseSketch(d, { ...BUDGET, ops: 5 })).toThrow();
		const o = d.variants[2].ops[0];
		d.variants[2].ops[0] = Object.fromEntries(Object.entries(o).reverse());
		expect(() => parseSketch(d)).not.toThrow();
		d.variants[3].ops[0].label = 'changed';
		expect(() => parseSketch(d)).toThrow();
	});
	it('pays the simple-outline check once per distinct base: 60 edits of a 1000-point volume fit the budget', () => {
		const base: V2[] = Array.from({ length: 1000 }, (_, i) => [5 * Math.cos((i / 1000) * 2 * Math.PI), 5 * Math.sin((i / 1000) * 2 * Math.PI)]);
		const d = newDoc('d1', 'Test');
		for (let k = 0; k < 60; k++)
			d.variants[0].ops.push({ id: `o${k}`, label: 'x', author: 'user', t: k, ch: [{ id: 'v', el: { type: 'volume', plane: 'ground', base, h: 1 + k / 10, wall: null, mat: 'plaster', name: 'V' } }] });
		expect(() => parseSketch(JSON.parse(JSON.stringify(d)))).not.toThrow();
	});
	it('rejects an op that is not an op', () => {
		const d = withEls([]) as { variants: { ops: unknown[] }[] };
		d.variants[0].ops.push({ id: 5 });
		expect(() => parseSketch(d)).toThrow();
	});
});

describe('geom', () => {
	it('plane normals: ground up, front toward +z, side toward +x', () => {
		expect(close(normal(plane('ground')), [0, 1, 0])).toBe(true);
		expect(close(normal(plane('front')), [0, 0, 1])).toBe(true);
		expect(close(normal(plane('side')), [1, 0, 0])).toBe(true);
	});
	it('toWorld and toLocal are inverse on every plane', () => {
		for (const p of PLANES) {
			const w = toWorld(p, [2.5, -1.25]);
			expect(close(toLocal(p, w), [2.5, -1.25])).toBe(true);
		}
		// ground: local v grows away from the viewer (toward -z)
		expect(close(toWorld(plane('ground'), [1, 2]), [1, 0, -2])).toBe(true);
	});
	it('planeHit finds where a ray meets the plane', () => {
		const h = planeHit({ o: [1, 10, -2], d: [0, -1, 0] }, plane('ground'), [0, 0, 0]);
		expect(h.clamped).toBe(false);
		expect(close(h.p, [1, 2])).toBe(true);
	});
	it('planeHit clamps a ray that misses (horizon) to 30 m from the centre', () => {
		const h = planeHit({ o: [0, 2, 0], d: [0, 0.2, -1] }, plane('ground'), [0, 0, 0]);
		expect(h.clamped).toBe(true);
		expect(Math.hypot(...h.p)).toBeLessThanOrEqual(30 * Math.SQRT2 + 1e-9);
		const far = planeHit({ o: [0, 1, 0], d: [0, -0.001, -1] }, plane('ground'), [0, 0, 0]);
		expect(far.clamped).toBe(true);
		expect(Math.abs(far.p[1])).toBeLessThanOrEqual(30);
	});
	it('planeHit keeps every point within ±30 m of the plane origin, also when the view is panned', () => {
		const h = planeHit({ o: [40, 10, 0], d: [0, -1, 0] }, plane('ground'), [25, 0, 0]);
		expect(h.p[0]).toBeLessThanOrEqual(30);
		expect(h.clamped).toBe(true);
		const far = planeHit({ o: [25, 2, 0], d: [0, 0.2, -1] }, plane('ground'), [25, 0, 0]);
		expect(Math.max(...far.p.map(Math.abs))).toBeLessThanOrEqual(30);
	});
	it('heightAlong measures how far along the normal a ray passes closest', () => {
		// line x=0,z=0 going up; a horizontal ray at y=3 crossing it
		expect(heightAlong({ o: [-5, 3, 0], d: [1, 0, 0] }, [0, 0, 0], [0, 1, 0])).toBeCloseTo(3);
	});
	it('offsetPolygon moves a square inward by d for either winding', () => {
		const sq: V2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
		for (const P of [sq, sq.slice().reverse()]) {
			const q = offsetPolygon(P, 0.25)!;
			expect(Math.abs(area(q))).toBeCloseTo(9.5 * 9.5);
			for (const c of q.flat()) expect([0.25, 9.75].some((w) => Math.abs(c - w) < 1e-9)).toBe(true);
		}
	});
	it('offsetPolygon returns null when a narrow neck would make the inset cross itself', () => {
		// Two 4x4 rooms joined by a 0.2 m wide, 2 m long neck.
		const P: V2[] = [[0, 0], [4, 0], [4, 1.9], [6, 1.9], [6, 0], [10, 0], [10, 4], [6, 4], [6, 2.1], [4, 2.1], [4, 4], [0, 4]];
		expect(offsetPolygon(P, 0.25)).toBeNull();
	});
	it('offsetPolygon returns null when the inset collapses', () => {
		expect(offsetPolygon([[0, 0], [0.4, 0], [0.4, 0.4], [0, 0.4]], 0.25)).toBeNull();
	});
});

describe('recognize', () => {
	const jitter = (P: V2[], a = 0.03): V2[] => P.map(([x, y], i) => [x + Math.sin(i * 7.1) * a, y + Math.cos(i * 3.7) * a]);
	const seg = (a: V2, b: V2, n = 20): V2[] => Array.from({ length: n }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);

	it('a near-straight stroke is a line snapped to the axis', () => {
		const r = recognize(jitter(seg([0, 0], [5, 0.15], 30), 0.02))!;
		expect(r.shape).toBe('line');
		expect(r.closed).toBe(false);
		expect(r.pts[1][1]).toBeCloseTo(r.pts[0][1], 9); // horizontal
	});
	it('a hand-drawn rectangle with a small gap closes into a rectangle', () => {
		const P = jitter([...seg([0, 0], [4, 0]), ...seg([4, 0], [4, 3]), ...seg([4, 3], [0, 3]), ...seg([0, 3], [0, 0.25])]);
		const r = recognize(P)!;
		expect(r.shape).toBe('rect');
		expect(r.closed).toBe(true);
		const xs = r.pts.map((p) => p[0]), ys = r.pts.map((p) => p[1]);
		expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4, 0);
		expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(3, 0);
	});
	it('a round loop is a circle', () => {
		const P: V2[] = Array.from({ length: 60 }, (_, i) => [2 + 1.5 * Math.cos((i / 58) * 2 * Math.PI), 1 + 1.5 * Math.sin((i / 58) * 2 * Math.PI)]);
		const r = recognize(jitter(P, 0.02))!;
		expect(r.shape).toBe('circle');
		expect(r.closed).toBe(true);
	});
	it('a flat loop is an ellipse', () => {
		const P: V2[] = Array.from({ length: 60 }, (_, i) => [3 * Math.cos((i / 58) * 2 * Math.PI), 1 * Math.sin((i / 58) * 2 * Math.PI)]);
		expect(recognize(P)!.shape).toBe('ellipse');
	});
	it('an open wiggle stays a free stroke', () => {
		const P: V2[] = Array.from({ length: 40 }, (_, i) => [i * 0.1, Math.sin(i * 0.5)]);
		const r = recognize(P)!;
		expect(r.shape).toBe('free');
		expect(r.closed).toBe(false);
	});
	it('a straight out-and-back stroke stays open, never a degenerate closed shape', () => {
		const P: V2[] = [...seg([0, 0], [4, 0]), ...seg([4, 0], [0.05, 0.02])];
		const r = recognize(P)!;
		expect(r.closed && r.pts.length < 3).toBe(false);
		if (r.closed) expect(Math.abs(area(r.pts))).toBeGreaterThan(0.01);
	});
	it('a tiny rectangle that snaps to zero width never becomes a degenerate closed shape', () => {
		const P = [...seg([0, 0], [0.2, 0], 8), ...seg([0.2, 0], [0.2, 0.02], 3), ...seg([0.2, 0.02], [0, 0.02], 8), ...seg([0, 0.02], [0, 0.005], 2)];
		const r = recognize(P);
		if (r?.closed) expect(isSimple(r.pts)).toBe(true);
	});
	it('a long thin closed outline (a wall plan) stays closed', () => {
		const P = jitter([...seg([0, 0], [10, 0], 40), ...seg([10, 0], [10, 0.12], 4), ...seg([10, 0.12], [0, 0.12], 40), ...seg([0, 0.12], [0, 0.02], 4)], 0.003);
		const r = recognize(P)!;
		expect(r.closed).toBe(true);
		expect(isSimple(r.pts)).toBe(true);
	});
	it('a fast stroke with only two samples is a line', () => {
		const r = recognize([[0, 0], [3, 0.05]])!;
		expect(r?.shape).toBe('line');
	});
	it('a tiny scribble is ignored', () => {
		expect(recognize([[0, 0], [0.01, 0.01], [0.02, 0]])).toBeNull();
	});
});

describe('mesh', () => {
	const rect: V2[] = [[0, 0], [2, 0], [2, 3], [0, 3]];
	it('a solid box has 12 triangles between z=0 and z=h', () => {
		const m = volumeMesh(rect, 4, null);
		expect(m.index.length / 3).toBe(12);
		const zs = new Set<number>();
		for (let i = 2; i < m.positions.length; i += 3) zs.add(m.positions[i]);
		expect([...zs].sort()).toEqual([0, 4]);
		expect(m.edges.length / 6).toBe(12);
	});
	it('a wall is a ring: 32 triangles, inner face inset by the thickness', () => {
		const m = volumeMesh([[0, 0], [4, 0], [4, 4], [0, 4]], 3, 0.25);
		expect(m.index.length / 3).toBe(32);
		const xs: number[] = [];
		for (let i = 0; i < m.positions.length; i += 3) xs.push(m.positions[i]);
		expect(xs.some((x) => Math.abs(x - 0.25) < 1e-9)).toBe(true);
		expect(xs.some((x) => Math.abs(x - 3.75) < 1e-9)).toBe(true);
	});
	it.each([4, -2])('every triangle of a box (h=%d) faces outward, for either outline winding', (h) => {
		for (const base of [rect, rect.slice().reverse()]) {
			const m = volumeMesh(base, h, null);
			const P = (i: number) => [m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2]];
			const c = [1, 1.5, h / 2];
			for (let k = 0; k < m.index.length; k += 3) {
				const [a, b, d] = [P(m.index[k]), P(m.index[k + 1]), P(m.index[k + 2])];
				const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
				const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
				const g = [(a[0] + b[0] + d[0]) / 3 - c[0], (a[1] + b[1] + d[1]) / 3 - c[1], (a[2] + b[2] + d[2]) / 3 - c[2]];
				expect(n[0] * g[0] + n[1] * g[1] + n[2] * g[2]).toBeGreaterThan(0);
			}
		}
	});
	it.each([3, -2])('every triangle of a wall ring (h=%d) faces out of the wall, for either winding', (h) => {
		const sq: V2[] = [[0, 0], [4, 0], [4, 4], [0, 4]];
		for (const base of [sq, sq.slice().reverse()]) {
			const m = volumeMesh(base, h, 0.25);
			const P = (i: number) => [m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2]];
			for (let k = 0; k < m.index.length; k += 3) {
				const [a, b, d] = [P(m.index[k]), P(m.index[k + 1]), P(m.index[k + 2])];
				const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
				const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
				const g = [(a[0] + b[0] + d[0]) / 3, (a[1] + b[1] + d[1]) / 3, (a[2] + b[2] + d[2]) / 3];
				if (Math.abs(n[2]) > Math.hypot(n[0], n[1])) {
					expect(Math.sign(n[2])).toBe(Math.sign(g[2] - h / 2)); // cap: away from the middle
				} else {
					const r = Math.max(Math.abs(g[0] - 2), Math.abs(g[1] - 2)); // 2 = outer face, 1.75 = inner face
					const out = n[0] * (g[0] - 2) + n[1] * (g[1] - 2);
					expect(Math.sign(out)).toBe(r > 1.9 ? 1 : -1);
				}
			}
		}
	});
	it('a wall too thick for its outline falls back to solid', () => {
		expect(volumeMesh([[0, 0], [0.4, 0], [0.4, 0.4], [0, 0.4]], 3, 0.25).index.length / 3).toBe(12);
	});
	it('a negative height goes below the plane', () => {
		const m = volumeMesh(rect, -2, null);
		let min = 0;
		for (let i = 2; i < m.positions.length; i += 3) min = Math.min(min, m.positions[i]);
		expect(min).toBe(-2);
	});
});

describe('edit', () => {
	it('commit, undo, redo move ops on the current variant', () => {
		let d = newDoc('d', 'x');
		d = commit(d, 'Ορθογώνιο', [{ id: 'a', el: { type: 'stroke', plane: 'ground', pts: [[0, 0], [1, 0]], closed: false, shape: 'line' } }], 'op1', 1);
		expect(replay(current(d).ops).has('a')).toBe(true);
		const u = undo(d)!;
		expect(replay(current(u.doc).ops).has('a')).toBe(false);
		const r = redo(u.doc, u.op);
		expect(replay(current(r).ops).has('a')).toBe(true);
		expect(undo(newDoc('d', 'x'))).toBeNull();
	});
});

describe('PenGate (palm rejection)', () => {
	it('lets touch navigate when no pen is around', () => {
		const g = new PenGate();
		expect(g.allowTouch(1000)).toBe(true);
	});
	it('blocks touch while the pen is down and shortly after it was seen', () => {
		const g = new PenGate();
		g.pen(1000, true);
		expect(g.allowTouch(5000)).toBe(false);
		g.pen(5000, false);
		expect(g.allowTouch(5200)).toBe(false);
		expect(g.allowTouch(5000 + PenGate.HOLD_MS + 1)).toBe(true);
	});
	it('blocks touch while the pen hovers without moving, until it leaves or goes stale', () => {
		const g = new PenGate();
		g.hover(1000, true);
		expect(g.allowTouch(1000 + PenGate.HOLD_MS + 500)).toBe(false);
		g.hover(1900, false);
		expect(g.allowTouch(1900 + PenGate.HOLD_MS + 1)).toBe(true);
		const h = new PenGate();
		h.hover(1000, true);
		expect(h.allowTouch(1000 + PenGate.HOVER_STALE_MS + 1)).toBe(true);
	});
});
