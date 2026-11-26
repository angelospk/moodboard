// The sketch document: planes + variants of an op log (ops.ts). Element points live in plane
// coordinates (metres along the plane's u and v axes), so moving a plane moves its drawing.
// parseSketch is the only way in for JSON from a file, storage or an AI: it rejects, never repairs.
import { equal, type Op, type Variant } from './ops.js';
import { isSimple, type V2, type V3 } from './geom.js';

export const SCHEMA = 'sketch3d/1';
/** Plane coordinates stay within this many metres of the plane origin. */
export const LIMIT = 30;
export const MATERIALS = ['plaster', 'concrete', 'wood', 'stone', 'glass', 'marble'] as const;
export type Material = (typeof MATERIALS)[number];
export const SHAPES = ['line', 'rect', 'circle', 'ellipse', 'free'] as const;
export type Shape = (typeof SHAPES)[number];
export const WALL_MIN = 0.05, WALL_MAX = 2;

/** A frame: origin o, in-plane axes u (right) and v (up when you face it); normal = u x v. */
export interface Plane {
	id: string;
	name: string;
	o: V3;
	u: V3;
	v: V3;
}
export interface StrokeEl {
	type: 'stroke';
	plane: string;
	pts: V2[];
	closed: boolean;
	shape: Shape;
}
export interface VolumeEl {
	type: 'volume';
	plane: string;
	/** Closed outline on the plane. */
	base: V2[];
	/** Extrusion along the plane normal; negative goes behind/below the plane. */
	h: number;
	/** Wall thickness (inward from the outline), or null for a solid volume. */
	wall: number | null;
	mat: Material;
	name: string;
}
export type Element = StrokeEl | VolumeEl;
export interface SketchDoc {
	schema: typeof SCHEMA;
	id: string;
	title: string;
	planes: Plane[];
	variants: Variant<Element>[];
	/** The variant being edited. */
	current: string;
}

export const PLANES: readonly Plane[] = [
	{ id: 'ground', name: 'Δάπεδο', o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, -1] },
	{ id: 'front', name: 'Πρόσοψη', o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] },
	{ id: 'side', name: 'Πλάγια', o: [0, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }
];

export function newDoc(id: string, title: string): SketchDoc {
	return {
		schema: SCHEMA,
		id,
		title,
		planes: PLANES.map((p) => structuredClone(p) as Plane),
		variants: [{ id: 'main', name: 'Κύριο', ops: [] }],
		current: 'main'
	};
}

// ---- validation ----
const MAX = { planes: 64, variants: 64, ops: 50000, changes: 2000, pts: 4000, base: 1000, str: 200 };
/** Limits for the whole document: history multiplies per-list limits, so every list is charged here
 * before it is copied. `pairs` pays for the O(n²) simple-outline check of volume bases. */
export const BUDGET = { ops: 50000, changes: 200000, points: 2_000_000, merged: 500000, pairs: 50_000_000 };
export type Budget = typeof BUDGET;

class Bad extends Error {}
function fail(path: string, why: string): never {
	throw new Bad(`sketch: ${path}: ${why}`);
}
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
function obj(x: unknown, path: string, keys: string[], optional: string[] = []): Record<string, unknown> {
	if (!isObj(x)) fail(path, 'not an object');
	for (const k of Object.keys(x)) if (!keys.includes(k) && !optional.includes(k)) fail(path, `unknown field ${k}`);
	for (const k of keys) if (!(k in x)) fail(path, `missing ${k}`);
	return x;
}
function str(x: unknown, path: string): string {
	if (typeof x !== 'string' || x.length === 0 || x.length > MAX.str) fail(path, 'not a short string');
	return x;
}
function num(x: unknown, path: string, lim = Infinity): number {
	if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > lim) fail(path, `not a number within ±${lim}`);
	return x;
}
function arr(x: unknown, path: string, min: number, max: number): unknown[] {
	if (!Array.isArray(x) || x.length < min || x.length > max) fail(path, `not a list of ${min}..${max}`);
	return x;
}
const v3 = (x: unknown, path: string, lim = 1000) => arr(x, path, 3, 3).map((c, i) => num(c, `${path}[${i}]`, lim)) as V3;
function charge(b: Budget, k: keyof Budget, n: number, path: string) {
	b[k] -= n;
	if (b[k] < 0) fail(path, `document too large (${k})`);
}
function v2s(x: unknown, path: string, min: number, max: number, b: Budget): V2[] {
	charge(b, 'points', arr(x, path, min, max).length, path);
	return (x as unknown[]).map((p, i) => arr(p, `${path}[${i}]`, 2, 2).map((c, j) => num(c, `${path}[${i}][${j}]`, LIMIT)) as V2);
}
function oneOf<T extends string>(x: unknown, path: string, list: readonly T[]): T {
	if (!list.includes(x as T)) fail(path, `not one of ${list.join('/')}`);
	return x as T;
}

/** Simple-outline results by base, so repeated snapshots of one outline (height, wall and
 * material edits) pay the O(n²) check once. */
type Simple = Map<string, boolean>;

function element(x: unknown, path: string, planes: Set<string>, b: Budget, simple: Simple): Element {
	if (!isObj(x)) fail(path, 'not an object');
	const plane = (p: unknown) => {
		const id = str(p, `${path}.plane`);
		if (!planes.has(id)) fail(`${path}.plane`, `unknown plane ${id}`);
		return id;
	};
	if (x.type === 'stroke') {
		const o = obj(x, path, ['type', 'plane', 'pts', 'closed', 'shape']);
		if (typeof o.closed !== 'boolean') fail(`${path}.closed`, 'not a boolean');
		return { type: 'stroke', plane: plane(o.plane), pts: v2s(o.pts, `${path}.pts`, o.closed ? 3 : 2, MAX.pts, b), closed: o.closed, shape: oneOf(o.shape, `${path}.shape`, SHAPES) };
	}
	if (x.type === 'volume') {
		const o = obj(x, path, ['type', 'plane', 'base', 'h', 'wall', 'mat', 'name']);
		const h = num(o.h, `${path}.h`, 2 * LIMIT);
		if (Math.abs(h) < 1e-3) fail(`${path}.h`, 'zero height');
		let wall: number | null = null;
		if (o.wall !== null) {
			wall = num(o.wall, `${path}.wall`);
			if (wall < WALL_MIN || wall > WALL_MAX) fail(`${path}.wall`, `not within ${WALL_MIN}..${WALL_MAX}`);
		}
		const base = v2s(o.base, `${path}.base`, 3, MAX.base, b);
		const key = JSON.stringify(base);
		let ok = simple.get(key);
		if (ok === undefined) {
			charge(b, 'pairs', base.length * base.length, `${path}.base`);
			simple.set(key, (ok = isSimple(base)));
		}
		if (!ok) fail(`${path}.base`, 'not a simple outline');
		return {
			type: 'volume',
			plane: plane(o.plane),
			base,
			h,
			wall,
			mat: oneOf(o.mat, `${path}.mat`, MATERIALS),
			name: str(o.name, `${path}.name`)
		};
	}
	return fail(`${path}.type`, 'unknown element type');
}

function op(x: unknown, path: string, planes: Set<string>, b: Budget, simple: Simple): Op<Element> {
	const o = obj(x, path, ['id', 'label', 'author', 't', 'ch'], ['mergeOf', 'merged']);
	const isMerge = o.mergeOf !== undefined;
	if (!isMerge && o.merged !== undefined) fail(`${path}.merged`, 'only on a merge op');
	charge(b, 'changes', arr(o.ch, `${path}.ch`, 0, MAX.changes).length, `${path}.ch`);
	const out: Op<Element> = {
		id: str(o.id, `${path}.id`),
		label: str(o.label, `${path}.label`),
		author: oneOf(o.author, `${path}.author`, ['user', 'ai', 'import'] as const),
		t: num(o.t, `${path}.t`),
		ch: arr(o.ch, `${path}.ch`, 0, MAX.changes).map((c, i) => {
			const p = `${path}.ch[${i}]`;
			const co = obj(c, p, ['id', 'el'], ['from']);
			const ch: Op<Element>['ch'][number] = { id: str(co.id, `${p}.id`), el: co.el === null ? null : element(co.el, `${p}.el`, planes, b, simple) };
			if (co.from !== undefined) {
				if (!isMerge) fail(`${p}.from`, 'only on a merge op');
				ch.from = str(co.from, `${p}.from`);
			}
			return ch;
		})
	};
	if (o.mergeOf !== undefined) out.mergeOf = str(o.mergeOf, `${path}.mergeOf`);
	if (o.merged !== undefined) {
		charge(b, 'merged', arr(o.merged, `${path}.merged`, 0, MAX.ops).length, `${path}.merged`);
		out.merged = (o.merged as unknown[]).map((m, i) => str(m, `${path}.merged[${i}]`));
	}
	return out;
}

/** Validate untrusted JSON as a sketch document. Throws on anything off; never repairs. */
export function parseSketch(x: unknown, budget: Budget = BUDGET): SketchDoc {
	const b = { ...budget };
	const d = obj(x, 'doc', ['schema', 'id', 'title', 'planes', 'variants', 'current']);
	if (d.schema !== SCHEMA) fail('doc.schema', `not ${SCHEMA}`);
	const planes = arr(d.planes, 'doc.planes', 1, MAX.planes).map((p, i) => {
		const o = obj(p, `doc.planes[${i}]`, ['id', 'name', 'o', 'u', 'v']);
		return { id: str(o.id, `doc.planes[${i}].id`), name: str(o.name, `doc.planes[${i}].name`), o: v3(o.o, `doc.planes[${i}].o`, LIMIT), u: v3(o.u, `doc.planes[${i}].u`, 1), v: v3(o.v, `doc.planes[${i}].v`, 1) };
	});
	const pids = new Set(planes.map((p) => p.id));
	if (pids.size !== planes.length) fail('doc.planes', 'duplicate id');
	for (const [i, p] of planes.entries()) {
		const lu = Math.hypot(...p.u), lv = Math.hypot(...p.v), uv = p.u[0] * p.v[0] + p.u[1] * p.v[1] + p.u[2] * p.v[2];
		if (Math.abs(lu - 1) > 1e-6 || Math.abs(lv - 1) > 1e-6 || Math.abs(uv) > 1e-6) fail(`doc.planes[${i}]`, 'u, v not orthonormal');
	}
	// Variants share the ops before their fork. The same op id in two variants must be the same op.
	// Every copy is stored, so every copy is validated and charged.
	const seen = new Map<string, Op<Element>>();
	const simple: Simple = new Map();
	const variants = arr(d.variants, 'doc.variants', 1, MAX.variants).map((v, i) => {
		const o = obj(v, `doc.variants[${i}]`, ['id', 'name', 'ops'], ['from']);
		const ids = new Set<string>();
		const ops = arr(o.ops, `doc.variants[${i}].ops`, 0, MAX.ops).map((x, j) => {
			const path = `doc.variants[${i}].ops[${j}]`;
			charge(b, 'ops', 1, path);
			const r = op(x, path, pids, b, simple);
			const prev = seen.get(r.id);
			if (!prev) seen.set(r.id, r);
			else if (!equal(prev, r)) fail(path, `op ${r.id} differs from the op with that id in another variant`);
			if (ids.has(r.id)) fail(path, `duplicate op id ${r.id}`);
			ids.add(r.id);
			return r;
		});
		const out: Variant<Element> = { id: str(o.id, `doc.variants[${i}].id`), name: str(o.name, `doc.variants[${i}].name`), ops };
		if (o.from !== undefined) out.from = str(o.from, `doc.variants[${i}].from`);
		return out;
	});
	if (new Set(variants.map((v) => v.id)).size !== variants.length) fail('doc.variants', 'duplicate id');
	const current = str(d.current, 'doc.current');
	if (!variants.some((v) => v.id === current)) fail('doc.current', 'no such variant');
	return { schema: SCHEMA, id: str(d.id, 'doc.id'), title: str(d.title, 'doc.title'), planes, variants, current };
}
