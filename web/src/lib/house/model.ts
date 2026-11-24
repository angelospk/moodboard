// The house model of the 3D editor: a flat list of typed building elements, in metres.
//
// Coordinates: plan point [x, y] on the ground, x east, y north; z (elevation) up. This is the IFC
// and CAD convention. The three.js scene (Y up) maps a plan point to (x, z, -y), as Blender does
// for glTF, so the exported .glb opens the right way up and is not mirrored.
//
// Every element has a `type`. Windows and doors live on a wall (`host`), on one straight segment of
// its polyline, at `offset` metres from the segment start (to the opening's centre).

export type Vec2 = [number, number];

export const SCHEMA_ID = 'moodboard.house/v1';

export type ElementType = 'wall' | 'slab' | 'window' | 'door' | 'pool' | 'box';

interface Base {
	id: string;
	type: ElementType;
	name: string;
	/** Id in MATERIALS (materials.ts). */
	material: string;
}

export interface Wall extends Base {
	type: 'wall';
	/** Polyline on the ground, at least 2 points. Each pair is one straight segment. */
	points: Vec2[];
	height: number;
	thickness: number;
	/** Elevation of the wall bottom. */
	base: number;
}

export interface Opening extends Base {
	type: 'window' | 'door';
	host: string;
	/** Index of the host wall's segment (points[segment] → points[segment + 1]). */
	segment: number;
	/** Distance along the segment from its start to the opening's centre. */
	offset: number;
	width: number;
	height: number;
	/** Height of the opening's bottom above the wall bottom (0 for a door). */
	sill: number;
}

export interface Slab extends Base {
	type: 'slab';
	/** Closed outline on the ground (no repeated last point), at least 3 points. */
	outline: Vec2[];
	/** Elevation of the slab top. */
	elevation: number;
	thickness: number;
}

/** Axis-aligned in its own frame, turned by `rotation` degrees (counter-clockwise, seen from above). */
interface Placed extends Base {
	center: Vec2;
	width: number; // along x before rotation
	length: number; // along y before rotation
	rotation: number;
}

export interface Pool extends Placed {
	type: 'pool';
	/** Water depth below the ground (z = 0). */
	depth: number;
}

export interface Box extends Placed {
	type: 'box';
	height: number;
	/** Elevation of the box bottom. */
	base: number;
}

export type Element = Wall | Opening | Slab | Pool | Box;

export interface HouseModel {
	schema: typeof SCHEMA_ID;
	units: 'm';
	elements: Element[];
}

export const DEFAULTS = {
	wall: { height: 3, thickness: 0.25, base: 0, material: 'plaster_white' },
	window: { width: 1.2, height: 1.4, sill: 0.9, material: 'glass' },
	door: { width: 0.9, height: 2.1, sill: 0, material: 'wood_oak' },
	slab: { elevation: 0, thickness: 0.2, material: 'concrete' },
	pool: { width: 4, length: 8, depth: 1.5, rotation: 0, material: 'pool_water' },
	box: { width: 2, length: 2, height: 2, base: 0, rotation: 0, material: 'concrete' }
} as const;

/** Gap kept between an opening and the end of its segment. */
export const OPENING_MARGIN = 0.05;

export function emptyModel(): HouseModel {
	return { schema: SCHEMA_ID, units: 'm', elements: [] };
}

export function newElementId(): string {
	return Math.random().toString(36).slice(2, 10);
}

// ------------------------------------------------------------------ Geometry helpers

export interface Segment {
	index: number;
	a: Vec2;
	b: Vec2;
	length: number;
	/** Unit direction a → b. */
	dir: Vec2;
}

export function segments(wall: Pick<Wall, 'points'>): Segment[] {
	const out: Segment[] = [];
	for (let i = 0; i + 1 < wall.points.length; i++) {
		const a = wall.points[i];
		const b = wall.points[i + 1];
		const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
		out.push({ index: i, a, b, length, dir: length ? [(b[0] - a[0]) / length, (b[1] - a[1]) / length] : [1, 0] });
	}
	return out;
}

/** Round to the grid; then snap to a known point (a wall corner) closer than `radius`. */
export function snapPoint(p: Vec2, grid: number, corners: Vec2[] = [], radius = 0.3): Vec2 {
	let best: Vec2 | null = null;
	let bestD = radius;
	for (const c of corners) {
		const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
		if (d <= bestD) {
			bestD = d;
			best = c;
		}
	}
	if (best) return [best[0], best[1]];
	if (grid <= 0) return [p[0], p[1]];
	const r = (v: number) => Math.round(v / grid) * grid + 0; // + 0 turns -0 into 0
	return [round6(r(p[0])), round6(r(p[1]))];
}

/** Snap the angle of `p` around `from` to a multiple of `step` degrees, keeping its length. */
export function snapAngle(from: Vec2, p: Vec2, step = 15): Vec2 {
	const dx = p[0] - from[0];
	const dy = p[1] - from[1];
	const len = Math.hypot(dx, dy);
	if (!len) return [p[0], p[1]];
	const s = (step * Math.PI) / 180;
	const a = Math.round(Math.atan2(dy, dx) / s) * s;
	return [round6(from[0] + Math.cos(a) * len), round6(from[1] + Math.sin(a) * len)];
}

export function round6(v: number): number {
	return Math.round(v * 1e6) / 1e6 + 0;
}

/** Nearest point on a wall to `p`: segment index and distance along it, plus the distance to `p`. */
export function nearestOnWall(wall: Wall, p: Vec2): { segment: number; offset: number; distance: number } | null {
	let best: { segment: number; offset: number; distance: number } | null = null;
	for (const s of segments(wall)) {
		if (!s.length) continue;
		const t = Math.max(0, Math.min(s.length, (p[0] - s.a[0]) * s.dir[0] + (p[1] - s.a[1]) * s.dir[1]));
		const q: Vec2 = [s.a[0] + s.dir[0] * t, s.a[1] + s.dir[1] * t];
		const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
		if (!best || d < best.distance) best = { segment: s.index, offset: t, distance: d };
	}
	return best;
}

/** A wall whose last point is its first: a closed loop, every corner is a joint. */
export function isClosed(points: Vec2[]): boolean {
	const f = points[0];
	const l = points[points.length - 1];
	return points.length > 3 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-6;
}

/** Clear length at each end of a segment: at a joint the next wall fills half its thickness. */
export function endGaps(wall: Pick<Wall, 'points' | 'thickness'>, segment: number): [number, number] {
	const loop = isClosed(wall.points);
	const last = wall.points.length - 2;
	const joint = wall.thickness / 2 + OPENING_MARGIN;
	return [segment > 0 || loop ? joint : OPENING_MARGIN, segment < last || loop ? joint : OPENING_MARGIN];
}

/** Keep an opening inside its segment (clear of joints) and its wall height. Returns a new opening. */
export function fitOpening(o: Opening, wall: Wall): Opening {
	const seg = segments(wall)[o.segment];
	const len = seg?.length ?? 0;
	const [g0, g1] = endGaps(wall, o.segment);
	const width = Math.max(0.1, Math.min(o.width, len - g0 - g1));
	const half = width / 2;
	const offset = Math.max(half + g0, Math.min(len - half - g1, o.offset));
	const sill = o.type === 'door' ? 0 : Math.max(0, Math.min(o.sill, wall.height - 0.2));
	const height = Math.max(0.1, Math.min(o.height, wall.height - sill - OPENING_MARGIN));
	return { ...o, width: round6(width), offset: round6(offset), sill: round6(sill), height: round6(height) };
}

/**
 * The face of one wall segment, seen from its front, as a 2D polygon in segment space (u along the
 * segment from 0 to length, v up from the wall bottom). Doors cut notches into the outline (they reach
 * the bottom edge, which a hole may not; so does a window with no sill); windows are holes. Openings
 * that leave the face or overlap an earlier one are skipped; `openings` lists the ones that were cut,
 * with their `id`, so the scene draws a glass or door panel only where the wall has a hole.
 */
export function wallFace(length: number, height: number, openings: (Pick<Opening, 'type' | 'offset' | 'width' | 'height' | 'sill'> & { id?: string })[]) {
	const placed: { id?: string; u0: number; u1: number; v0: number; v1: number; door: boolean }[] = [];
	for (const o of [...openings].sort((x, y) => x.offset - y.offset)) {
		const u0 = o.offset - o.width / 2;
		const u1 = o.offset + o.width / 2;
		const v0 = o.type === 'door' ? 0 : o.sill;
		const door = v0 < 0.001; // reaches the bottom edge: a notch, not a hole
		const v1 = Math.min(height - OPENING_MARGIN, v0 + o.height);
		if (u0 < OPENING_MARGIN / 2 || u1 > length - OPENING_MARGIN / 2 || v1 <= v0) continue;
		// Two holes may share a column (a window over a door) but must not touch; a notch takes its whole column.
		const clash = (p: (typeof placed)[number]) =>
			u0 < p.u1 + 0.01 && u1 > p.u0 - 0.01 && (door || p.door || (v0 < p.v1 + 0.01 && v1 > p.v0 - 0.01));
		if (placed.some(clash)) continue;
		placed.push({ id: o.id, u0, u1, v0, v1, door });
	}
	const outline: Vec2[] = [[0, 0]];
	for (const p of placed.filter((p) => p.door)) outline.push([p.u0, 0], [p.u0, p.v1], [p.u1, p.v1], [p.u1, 0]);
	outline.push([length, 0], [length, height], [0, height]);
	const holes: Vec2[][] = placed
		.filter((p) => !p.door)
		.map((p) => [
			[p.u0, p.v0],
			[p.u1, p.v0],
			[p.u1, p.v1],
			[p.u0, p.v1]
		]);
	return { outline, holes, openings: placed };
}

// ------------------------------------------------------------------ Editing

export function openingsOf(model: HouseModel, wallId: string): Opening[] {
	return model.elements.filter((e): e is Opening => (e.type === 'window' || e.type === 'door') && e.host === wallId);
}

/** True when no two non-adjacent edges of the closed polygon touch or cross, and it has an area. */
export function isSimplePolygon(points: Vec2[]): boolean {
	const n = points.length;
	if (n < 3 || polygonArea(points) < 1e-9) return false;
	const cross = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
	const onSeg = (a: Vec2, b: Vec2, c: Vec2) =>
		Math.min(a[0], b[0]) - 1e-9 <= c[0] && c[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= c[1] && c[1] <= Math.max(a[1], b[1]) + 1e-9;
	const meet = (a: Vec2, b: Vec2, c: Vec2, d: Vec2) => {
		const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
		if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
		return (Math.abs(d1) < 1e-12 && onSeg(c, d, a)) || (Math.abs(d2) < 1e-12 && onSeg(c, d, b)) || (Math.abs(d3) < 1e-12 && onSeg(a, b, c)) || (Math.abs(d4) < 1e-12 && onSeg(a, b, d));
	};
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			if (j === i + 1 || (i === 0 && j === n - 1)) continue; // neighbours share a corner
			if (meet(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return false;
		}
	}
	return true;
}

/**
 * The openings a wall segment really cuts (by id), given all openings of the wall. Uses the plain
 * segment length; the scene's corner extension only adds room, so whatever passes here is cut there.
 */
export function cutOpenings(wall: Wall, openings: Opening[], segment: number): Set<string> {
	const s = segments(wall)[segment];
	if (!s) return new Set();
	const face = wallFace(s.length, wall.height, openings.filter((o) => o.segment === segment));
	return new Set(face.openings.map((o) => o.id!).filter(Boolean));
}

/** Ids of all openings the model's walls really cut. Scene, export and editor use the same set. */
export function cutIds(model: HouseModel): Set<string> {
	const out = new Set<string>();
	for (const w of model.elements) {
		if (w.type !== 'wall') continue;
		const own = openingsOf(model, w.id);
		for (const seg of new Set(own.map((o) => o.segment))) for (const id of cutOpenings(w, own, seg)) out.add(id);
	}
	return out;
}

/** Area of a simple polygon (shoelace), always ≥ 0. */
export function polygonArea(points: Vec2[]): number {
	let a = 0;
	for (let i = 0; i < points.length; i++) {
		const [x0, y0] = points[i];
		const [x1, y1] = points[(i + 1) % points.length];
		a += x0 * y1 - x1 * y0;
	}
	return Math.abs(a) / 2;
}

/** Remove an element; removing a wall also removes its windows and doors. */
export function removeElement(model: HouseModel, id: string): HouseModel {
	return { ...model, elements: model.elements.filter((e) => e.id !== id && !((e.type === 'window' || e.type === 'door') && e.host === id)) };
}

export function wallCorners(model: HouseModel): Vec2[] {
	return model.elements.flatMap((e) => (e.type === 'wall' ? e.points : []));
}

// ------------------------------------------------------------------ Loading

const num = (v: unknown, lo: number, hi: number, d: number) =>
	typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
const str = (v: unknown, d: string, max = 120) => (typeof v === 'string' && v ? v.slice(0, max) : d);
const vec = (v: unknown): Vec2 | null =>
	Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10000)
		? [v[0], v[1]]
		: null;
const vecs = (v: unknown): Vec2[] => (Array.isArray(v) ? v.map(vec).filter((p): p is Vec2 => p !== null) : []);

/**
 * Read a model from stored or pasted JSON. Unknown element types and broken elements are dropped,
 * numbers are clamped to sane ranges, and openings whose wall is gone are dropped. Never throws.
 */
export function parseModel(raw: unknown): HouseModel {
	const m = emptyModel();
	const list = raw && typeof raw === 'object' && Array.isArray((raw as { elements?: unknown }).elements) ? (raw as { elements: unknown[] }).elements : [];
	const seen = new Set<string>();
	for (const r of list) {
		if (!r || typeof r !== 'object') continue;
		const e = r as Record<string, unknown>;
		let id = str(e.id, '', 40);
		if (!id || seen.has(id)) id = newElementId();
		seen.add(id);
		const name = str(e.name, '');
		const t = e.type;
		if (t === 'wall') {
			const points = vecs(e.points);
			// A dropped point would shift the segment indexes that windows and doors refer to.
			if (points.length < 2 || points.length !== (e.points as unknown[]).length) continue;
			const d = DEFAULTS.wall;
			m.elements.push({ id, type: t, name, material: str(e.material, d.material), points,
				height: num(e.height, 0.1, 100, d.height), thickness: num(e.thickness, 0.02, 5, d.thickness), base: num(e.base, -100, 1000, d.base) });
		} else if (t === 'window' || t === 'door') {
			const d = DEFAULTS[t];
			m.elements.push({ id, type: t, name, material: str(e.material, d.material), host: str(e.host, '', 40),
				segment: Math.trunc(num(e.segment, 0, 10000, 0)), offset: num(e.offset, 0, 10000, 0),
				width: num(e.width, 0.1, 50, d.width), height: num(e.height, 0.1, 50, d.height), sill: t === 'door' ? 0 : num(e.sill, 0, 50, d.sill) });
		} else if (t === 'slab') {
			const outline = vecs(e.outline);
			if (!isSimplePolygon(outline)) continue;
			const d = DEFAULTS.slab;
			m.elements.push({ id, type: t, name, material: str(e.material, d.material), outline,
				elevation: num(e.elevation, -100, 1000, d.elevation), thickness: num(e.thickness, 0.02, 5, d.thickness) });
		} else if (t === 'pool' || t === 'box') {
			const center = vec(e.center);
			if (!center) continue;
			const common = { id, name, center, rotation: num(e.rotation, -360, 360, 0) };
			if (t === 'pool') {
				const d = DEFAULTS.pool;
				m.elements.push({ ...common, type: t, material: str(e.material, d.material),
					width: num(e.width, 0.25, 100, d.width), length: num(e.length, 0.25, 100, d.length), depth: num(e.depth, 0.1, 10, d.depth) });
			} else {
				const d = DEFAULTS.box;
				m.elements.push({ ...common, type: t, material: str(e.material, d.material),
					width: num(e.width, 0.05, 200, d.width), length: num(e.length, 0.05, 200, d.length),
					height: num(e.height, 0.05, 200, d.height), base: num(e.base, -100, 1000, d.base) });
			}
		}
	}
	// Openings need a wall that exists and a segment it has, and are fitted to it (clear of joints,
	// inside its height). One that its wall cannot cut (it overlaps an earlier one) is kept: the
	// editor shows it as a problem to fix, and export drops it with the rest of the scene.
	const walls = new Map(m.elements.filter((e): e is Wall => e.type === 'wall').map((w) => [w.id, w]));
	m.elements = m.elements.flatMap((e): Element[] => {
		if (e.type !== 'window' && e.type !== 'door') return [e];
		const w = walls.get(e.host);
		return w && e.segment < w.points.length - 1 ? [fitOpening(e, w)] : [];
	});
	return m;
}
