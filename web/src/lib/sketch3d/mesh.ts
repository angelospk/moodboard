// Volume -> triangle mesh in plane-local space (x = u, y = v, z = along the normal). Flat shading:
// every face has its own vertices. A wall is the outline minus its inset, as a ring.
import { ShapeUtils, Vector2 } from 'three';
import { area, offsetPolygon, type V2 } from './geom.js';

export interface Mesh {
	positions: number[];
	index: number[];
	/** Outline edges as line-segment pairs: x0 y0 z0 x1 y1 z1 ... */
	edges: number[];
}

export function volumeMesh(base: V2[], h: number, wall: number | null): Mesh {
	// Work with a CCW outline so side faces point outward.
	const outer = area(base) < 0 ? base.slice().reverse() : base.slice();
	const inner = wall ? offsetPolygon(outer, wall) : null;
	const holes = inner ? [inner.slice().reverse()] : [];
	const m: Mesh = { positions: [], index: [], edges: [] };
	const vert = (p: V2, zz: number) => (m.positions.push(p[0], p[1], zz), m.positions.length / 3 - 1);
	const lo = Math.min(0, h), hi = Math.max(0, h);

	// Caps: triangulate once, use for bottom (reversed) and top.
	const tris = ShapeUtils.triangulateShape(
		outer.map((p) => new Vector2(p[0], p[1])),
		holes.map((hole) => hole.map((p) => new Vector2(p[0], p[1])))
	);
	const all = [...outer, ...holes.flat()];
	for (const [zz, flip] of [[lo, true], [hi, false]] as const) {
		const ids = all.map((p) => vert(p, zz));
		for (const t of tris) m.index.push(...(flip ? [ids[t[0]], ids[t[2]], ids[t[1]]] : [ids[t[0]], ids[t[1]], ids[t[2]]]));
	}
	// Sides: one quad per edge of each ring. The hole ring runs CW, so its quads face inward.
	for (const ring of [outer, ...holes]) {
		for (let i = 0; i < ring.length; i++) {
			const a = ring[i], b = ring[(i + 1) % ring.length];
			const q = [vert(a, lo), vert(b, lo), vert(b, hi), vert(a, hi)];
			m.index.push(q[0], q[1], q[2], q[0], q[2], q[3]);
			m.edges.push(a[0], a[1], lo, b[0], b[1], lo, a[0], a[1], hi, b[0], b[1], hi, a[0], a[1], lo, a[0], a[1], hi);
		}
	}
	return m;
}
