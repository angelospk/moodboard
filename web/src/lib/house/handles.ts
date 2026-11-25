// Edit handles of the selected element (slice E). Handles live in plan metres; the hit test works in
// screen pixels through a caller-given projection, so it knows nothing about three.js.
import { segments, type Element, type Vec2 } from './model.js';

/**
 * corner: a wall point (index = point index). mid: the "+" at a wall segment's midpoint (index =
 * segment). body: the whole wall (index -1, `path` = wall points, `at` = mean of the points).
 * center: an opening's centre on its wall, or a pool/box/item centre (index -1). rotate: the knob of a
 * pool/box/item, 0.5 m beyond its far edge along its rotated +y (index -1). vertex: a slab outline point.
 */
export type HandleKind = 'corner' | 'mid' | 'body' | 'center' | 'rotate' | 'vertex';

export interface Handle {
	/** Id of the element the handle edits. */
	element: string;
	kind: HandleKind;
	index: number;
	/** Plan position. */
	at: Vec2;
	/** body only: the polyline whose screen distance is hit-tested. */
	path?: Vec2[];
}

/** Hit radius in screen pixels by PointerEvent.pointerType; any other type uses mouse. */
export const HIT_PX: Record<'mouse' | 'pen' | 'touch', number> = { mouse: 8, pen: 10, touch: 22 };

/**
 * The handles of one element. Wall: corners (one per point, a closed loop's repeated last point
 * included), mids (one per segment), then body. Opening: center (needs the host wall: pass it as
 * `host`; none without it). Pool/box/item: center, rotate. Slab: one vertex per outline point.
 */
export function handlesFor(el: Element, host?: Element): Handle[] {
	if (el.type === 'wall') {
		const out: Handle[] = el.points.map((at, index) => ({ element: el.id, kind: 'corner' as const, index, at }));
		for (const s of segments(el)) {
			out.push({ element: el.id, kind: 'mid', index: s.index, at: [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2] });
		}
		const n = el.points.length;
		const at: Vec2 = [el.points.reduce((s, p) => s + p[0], 0) / n, el.points.reduce((s, p) => s + p[1], 0) / n];
		out.push({ element: el.id, kind: 'body', index: -1, at, path: el.points });
		return out;
	}
	if (el.type === 'window' || el.type === 'door') {
		if (!host || host.type !== 'wall') return [];
		const s = segments(host)[el.segment];
		if (!s) return [];
		return [{ element: el.id, kind: 'center', index: -1, at: [s.a[0] + s.dir[0] * el.offset, s.a[1] + s.dir[1] * el.offset] }];
	}
	if (el.type === 'slab') {
		return el.outline.map((at, index) => ({ element: el.id, kind: 'vertex' as const, index, at }));
	}
	if (el.type === 'pool' || el.type === 'box' || el.type === 'item') {
		// Centre plus a rotate knob 0.5 m beyond the far edge along the rotated +y.
		const a = (el.rotation * Math.PI) / 180;
		const dy = Math.cos(a);
		const dx = -Math.sin(a);
		const at: Vec2 = [el.center[0] + dx * (el.length / 2 + 0.5), el.center[1] + dy * (el.length / 2 + 0.5)];
		return [
			{ element: el.id, kind: 'center', index: -1, at: [el.center[0], el.center[1]] },
			{ element: el.id, kind: 'rotate', index: -1, at }
		];
	}
	return [];
}

/** Distance from `p` to the segment ab in screen pixels. */
function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len2 = dx * dx + dy * dy;
	if (!len2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
	let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

export function handleAt(handles: Handle[], pointer: Vec2, project: (p: Vec2) => Vec2, pointerType: string): Handle | null {
	const radius = HIT_PX[(pointerType as 'mouse' | 'pen' | 'touch') in HIT_PX ? (pointerType as 'mouse' | 'pen' | 'touch') : 'mouse'];
	const screen = pointer;
	let best: Handle | null = null;
	let bestD = radius;
	for (const h of handles) {
		if (h.kind === 'body') continue;
		const s = project(h.at);
		const d = Math.hypot(screen[0] - s[0], screen[1] - s[1]);
		if (d <= bestD) {
			bestD = d;
			best = h;
		}
	}
	if (best) return best;
	let bestBodyD = radius;
	for (const h of handles) {
		if (h.kind !== 'body' || !h.path || h.path.length < 2) continue;
		const pts = h.path.map(project);
		let d = Infinity;
		for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, distToSeg(screen, pts[i], pts[i + 1]));
		if (d <= bestBodyD) {
			bestBodyD = d;
			best = h;
		}
	}
	return best;
}
