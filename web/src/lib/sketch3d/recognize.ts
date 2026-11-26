// Pen stroke (plane coordinates, metres) -> clean shape: line, rectangle, circle, ellipse, or the
// free stroke as drawn. A loop whose ends nearly meet closes itself. Ported from prototype v2.
import { area, rdp, type V2 } from './geom.js';
import type { Shape } from './doc.js';

export interface Recognized {
	shape: Shape;
	pts: V2[];
	closed: boolean;
	/** Distance between the stroke's ends before closing (metres). */
	gap: number;
}

const pathLen = (P: V2[]) => P.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - P[i][0], p[1] - P[i][1]), 0);
const GRID = 0.05;
const snap = (v: number) => Math.round(v / GRID) * GRID;

export function recognize(P: V2[]): Recognized | null {
	const n = P.length;
	if (n < 2) return null;
	const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
	const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
	const diag = Math.hypot(x1 - x0, y1 - y0), L = pathLen(P);
	const a = P[0], b = P[n - 1], gap = Math.hypot(b[0] - a[0], b[1] - a[1]);
	if (diag < 0.05) return null;

	// Straight line: path barely longer than the chord, small deviation. Snap to an axis within 5°.
	if (gap > 0.3 && L < gap * 1.08) {
		const dx = b[0] - a[0], dy = b[1] - a[1];
		const dev = Math.max(...P.map((p) => Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / gap));
		if (dev < 0.05 * gap) {
			const ang = Math.atan2(dy, dx), q = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
			const end: V2 = Math.abs(ang - q) < 0.09 ? [a[0] + Math.cos(q) * gap, a[1] + Math.sin(q) * gap] : b;
			return { shape: 'line', pts: [a, end], closed: false, gap };
		}
	}
	const open = (): Recognized => ({ shape: 'free', pts: rdp(P, 0.004 * diag), closed: false, gap });
	if (n < 3) return open();
	const closed = gap < 0.15 * diag && L > 1.6 * diag;
	if (!closed) return open();
	const Q = gap > 1e-3 ? [...P, a] : P.slice();

	// Rectangle: four corners near 90°. Split the loop at its farthest points so RDP sees two chords.
	const c0: V2 = [(x0 + x1) / 2, (y0 + y1) / 2];
	let far = 0, fd = -1;
	Q.forEach((p, i) => {
		const d = Math.hypot(p[0] - c0[0], p[1] - c0[1]);
		if (d > fd) (fd = d), (far = i);
	});
	const R = [...Q.slice(far, -1), ...Q.slice(0, far), Q[far]];
	let k2 = 0, kd = -1;
	R.forEach((p, i) => {
		const d = Math.hypot(p[0] - R[0][0], p[1] - R[0][1]);
		if (d > kd) (kd = d), (k2 = i);
	});
	let cs = [...rdp(R.slice(0, k2 + 1), 0.075 * diag).slice(0, -1), ...rdp(R.slice(k2), 0.075 * diag).slice(0, -1)];
	const ang = (i: number) => {
		const p = cs[(i - 1 + cs.length) % cs.length], q = cs[i], r = cs[(i + 1) % cs.length];
		const u = [p[0] - q[0], p[1] - q[1]], v = [r[0] - q[0], r[1] - q[1]];
		const c = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]) || 1);
		return Math.acos(Math.max(-1, Math.min(1, c)));
	};
	for (let k = 0; k < 3; k++) cs = cs.filter((_, i) => ang(i) < Math.PI * 0.86 || cs.length <= 3);
	rect: if (cs.length === 4 && [0, 1, 2, 3].every((i) => Math.abs(ang(i) - Math.PI / 2) < 0.33)) {
		let th = 0, best = -1;
		for (let i = 0; i < 4; i++) {
			const p = cs[i], q = cs[(i + 1) % 4], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
			if (l > best) (best = l), (th = Math.atan2(q[1] - p[1], q[0] - p[0]));
		}
		th = ((th % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
		if (th > Math.PI / 4) th -= Math.PI / 2;
		if (Math.abs(th) < 0.14) th = 0;
		const co = Math.cos(th), si = Math.sin(th);
		const loc = cs.map((p) => [p[0] * co + p[1] * si, -p[0] * si + p[1] * co]);
		const lx = loc.map((p) => p[0]).sort((m, k) => m - k), ly = loc.map((p) => p[1]).sort((m, k) => m - k);
		const X0 = snap((lx[0] + lx[1]) / 2), X1 = snap((lx[2] + lx[3]) / 2), Y0 = snap((ly[0] + ly[1]) / 2), Y1 = snap((ly[2] + ly[3]) / 2);
		// Thinner than the grid: snapping would fold it flat, so try the other shapes.
		if (X1 - X0 < GRID / 2 || Y1 - Y0 < GRID / 2) break rect;
		const back = (q: V2): V2 => [q[0] * co - q[1] * si, q[0] * si + q[1] * co];
		return { shape: 'rect', pts: ([[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]] as V2[]).map(back), closed: true, gap };
	}

	// Circle / ellipse: fit the principal axes, check the mean radial error.
	const cx = Q.reduce((s, p) => s + p[0], 0) / Q.length, cy = Q.reduce((s, p) => s + p[1], 0) / Q.length;
	let sxx = 0, syy = 0, sxy = 0;
	for (const p of Q) {
		const dx = p[0] - cx, dy = p[1] - cy;
		sxx += dx * dx;
		syy += dy * dy;
		sxy += dx * dy;
	}
	let th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
	if (Math.abs(th) < 0.12) th = 0;
	else if (Math.abs(Math.abs(th) - Math.PI / 2) < 0.12) th = (Math.PI / 2) * Math.sign(th);
	const co = Math.cos(th), si = Math.sin(th);
	const L2 = Q.map((p) => [(p[0] - cx) * co + (p[1] - cy) * si, -(p[0] - cx) * si + (p[1] - cy) * co]);
	let ra = Math.sqrt((2 * L2.reduce((s, p) => s + p[0] * p[0], 0)) / L2.length);
	let rb = Math.sqrt((2 * L2.reduce((s, p) => s + p[1] * p[1], 0)) / L2.length);
	const err = Math.min(ra, rb) < 1e-3 ? Infinity : L2.reduce((s, p) => s + Math.abs(Math.hypot(p[0] / ra, p[1] / rb) - 1), 0) / L2.length;
	if (err < 0.11) {
		const circle = Math.abs(ra - rb) / Math.max(ra, rb) < 0.14;
		if (circle) ra = rb = Math.max(GRID, snap((ra + rb) / 2));
		const pts: V2[] = [];
		for (let k = 0; k < 48; k++) {
			const t = (k / 48) * 2 * Math.PI, x = Math.cos(t) * ra, y = Math.sin(t) * rb;
			pts.push([cx + x * co - y * si, cy + x * si + y * co]);
		}
		return { shape: circle ? 'circle' : 'ellipse', pts, closed: true, gap };
	}
	// A loop with almost no area for its length (a stroke that went out and came back) stays open.
	// Compactness 4πA/P² is 1 for a circle, about 0.04 for a 10 m × 0.12 m wall plan, ~0 for a sliver.
	const loop = rdp(Q, 0.004 * diag).slice(0, -1);
	const per = pathLen([...loop, loop[0]]);
	if (loop.length < 3 || (4 * Math.PI * Math.abs(area(loop))) / (per * per) < 0.01) return open();
	return { shape: 'free', pts: loop, closed: true, gap };
}
