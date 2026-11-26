// Small vector and plane geometry for the sketch (metres, world y up).
export type V2 = [number, number];
export type V3 = [number, number, number];
export interface Frame {
	o: V3;
	u: V3;
	v: V3;
}
export interface Ray {
	o: V3;
	d: V3;
}

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3): V3 => mul(a, 1 / (Math.hypot(...a) || 1));
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export const normal = (p: Frame): V3 => cross(p.u, p.v);
export const toWorld = (p: Frame, q: V2): V3 => add(p.o, add(mul(p.u, q[0]), mul(p.v, q[1])));
export function toLocal(p: Frame, w: V3): V2 {
	const d = sub(w, p.o);
	return [dot(d, p.u), dot(d, p.v)];
}

/** Where the ray meets the plane, in plane coordinates. A ray that misses the plane goes far
 * from `center` in its direction. The result always stays within ±limit of the plane origin
 * (the document bound); `clamped` says it was cut. */
export function planeHit(r: Ray, p: Frame, center: V3, limit = 30): { p: V2; clamped: boolean } {
	const n = normal(p);
	const c = toLocal(p, center);
	const den = dot(n, r.d);
	const t = Math.abs(den) > 1e-6 ? dot(n, sub(p.o, r.o)) / den : -1;
	let q: V2, clamped = false;
	if (t <= 0) {
		// Toward or along the horizon: go far in the ray's direction within the plane.
		const d = toLocal({ o: [0, 0, 0], u: p.u, v: p.v }, r.d);
		const l = Math.hypot(...d) || 1;
		q = [c[0] + (d[0] / l) * limit * 2, c[1] + (d[1] / l) * limit * 2];
		clamped = true;
	} else q = toLocal(p, add(r.o, mul(r.d, t)));
	const cu = clamp(q[0], -limit, limit), cv = clamp(q[1], -limit, limit);
	if (cu !== q[0] || cv !== q[1]) clamped = true;
	return { p: [cu, cv], clamped };
}

/** Parameter t of the point on the line o + n*t closest to the ray (push/pull height). */
export function heightAlong(r: Ray, o: V3, n: V3): number {
	const w = sub(o, r.o);
	const a = dot(n, n), b = dot(n, r.d), c = dot(r.d, r.d), d = dot(n, w), e = dot(r.d, w);
	const den = a * c - b * b;
	if (Math.abs(den) < 1e-9) return 0;
	return (b * e - c * d) / den;
}

export function area(P: V2[]): number {
	let s = 0;
	for (let i = 0; i < P.length; i++) {
		const a = P[i], b = P[(i + 1) % P.length];
		s += a[0] * b[1] - b[0] * a[1];
	}
	return s / 2;
}

/** Inset a simple polygon by d (mitred corners). Null when the inset collapses or turns over. */
export function offsetPolygon(P: V2[], d: number): V2[] | null {
	const n = P.length, s = Math.sign(area(P));
	if (n < 3 || s === 0) return null;
	// Inward normal of each edge: left of the edge for a CCW polygon.
	const lines = P.map((a, i) => {
		const b = P[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
		const nx = (-dy / l) * s, ny = (dx / l) * s;
		return { p: [a[0] + nx * d, a[1] + ny * d] as V2, dir: [dx / l, dy / l] as V2 };
	});
	const out: V2[] = [];
	for (let i = 0; i < n; i++) {
		const L1 = lines[(i - 1 + n) % n], L2 = lines[i];
		const cr = L1.dir[0] * L2.dir[1] - L1.dir[1] * L2.dir[0];
		if (Math.abs(cr) < 1e-9) {
			out.push(L2.p);
			continue;
		}
		const t = ((L2.p[0] - L1.p[0]) * L2.dir[1] - (L2.p[1] - L1.p[1]) * L2.dir[0]) / cr;
		out.push([L1.p[0] + L1.dir[0] * t, L1.p[1] + L1.dir[1] * t]);
	}
	const a0 = area(P), a1 = area(out);
	if (Math.sign(a1) !== Math.sign(a0) || Math.abs(a1) < 1e-4 || Math.abs(a1) >= Math.abs(a0)) return null;
	// Each inset edge must keep its direction, else a corner turned over.
	for (let i = 0; i < n; i++) {
		const a = out[i], b = out[(i + 1) % n];
		if ((b[0] - a[0]) * lines[i].dir[0] + (b[1] - a[1]) * lines[i].dir[1] <= 1e-6) return null;
	}
	// A narrow neck can still fold the inset over itself or push it outside the outline.
	if (!isSimple(out) || !out.every((q) => inside(q, P))) return null;
	return out;
}

const orient = (a: V2, b: V2, c: V2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSeg = (a: V2, b: V2, c: V2) =>
	Math.min(a[0], b[0]) - 1e-12 <= c[0] && c[0] <= Math.max(a[0], b[0]) + 1e-12 && Math.min(a[1], b[1]) - 1e-12 <= c[1] && c[1] <= Math.max(a[1], b[1]) + 1e-12;
function crosses(a: V2, b: V2, c: V2, d: V2): boolean {
	const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
	const e = 1e-12;
	if (((o1 > e && o2 < -e) || (o1 < -e && o2 > e)) && ((o3 > e && o4 < -e) || (o3 < -e && o4 > e))) return true;
	// Touching or overlapping (collinear) counts as crossing for a polygon outline.
	return (Math.abs(o1) <= e && onSeg(a, b, c)) || (Math.abs(o2) <= e && onSeg(a, b, d)) || (Math.abs(o3) <= e && onSeg(c, d, a)) || (Math.abs(o4) <= e && onSeg(c, d, b));
}

/** True when no two non-adjacent edges of the closed polygon touch, and it has a real area. O(n²). */
export function isSimple(P: V2[]): boolean {
	const n = P.length;
	if (n < 3 || Math.abs(area(P)) < 1e-6) return false;
	for (let i = 0; i < n; i++)
		for (let j = i + 1; j < n; j++) {
			if (j === i + 1 || (i === 0 && j === n - 1)) continue;
			if (crosses(P[i], P[(i + 1) % n], P[j], P[(j + 1) % n])) return false;
		}
	return true;
}

/** Point in polygon (even-odd). */
export function inside(q: V2, P: V2[]): boolean {
	let c = false;
	for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
		const a = P[i], b = P[j];
		if (a[1] > q[1] !== b[1] > q[1] && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
	}
	return c;
}

/** Distance from q to the segment ab (to the point a when ab has no length). */
export function segDist(q: V2, a: V2, b: V2): number {
	const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
	const t = l2 ? clamp(((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2, 0, 1) : 0;
	return Math.hypot(q[0] - (a[0] + dx * t), q[1] - (a[1] + dy * t));
}

/** Ramer-Douglas-Peucker simplification of a polyline (segment distance, so a closed loop works). */
export function rdp(P: V2[], eps: number): V2[] {
	if (P.length < 3) return P.slice();
	const a = P[0], b = P[P.length - 1];
	let mx = 0, k = 0;
	for (let i = 1; i < P.length - 1; i++) {
		const d = segDist(P[i], a, b);
		if (d > mx) (mx = d), (k = i);
	}
	if (mx <= eps) return [a, b];
	return [...rdp(P.slice(0, k + 1), eps).slice(0, -1), ...rdp(P.slice(k), eps)];
}
