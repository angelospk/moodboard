// Drag operations of the 3D editor (slice A). Pure functions on HouseModel: they never mutate their
// input and return a new model (or null when the change is refused). An unknown id returns the input
// model unchanged. They do not snap, fit or validate openings: the caller snaps the target point, and
// commit() runs parseModel (fitOpening) and the hidesOpening check on the result.
//
// Shared corner: a point of another wall (or of the same wall) within 1e-6 m of the moved point.
import type { Element, HouseModel, Opening, Slab, Vec2, Wall } from './model.js';
import { isSimplePolygon, nearestOnWall, round6, segments } from './model.js';

const EPS = 1e-6;

const isWall = (e: Element): e is Wall => e.type === 'wall';
const isOpening = (e: Element): e is Opening => e.type === 'window' || e.type === 'door';
const isPlaced = (e: Element): e is Extract<Element, { center: Vec2 }> => e.type === 'pool' || e.type === 'box' || e.type === 'item';

function findWall(m: HouseModel, id: string): Wall | undefined {
	return m.elements.find((e): e is Wall => isWall(e) && e.id === id);
}

function samePoint(a: Vec2, b: Vec2): boolean {
	return Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) <= EPS;
}

/** Segment lengths of every wall, keyed by wall id: the "before" picture for opening fractions. */
function oldSegLengths(m: HouseModel): Map<string, number[]> {
	const out = new Map<string, number[]>();
	for (const e of m.elements) if (isWall(e)) out.set(e.id, segments(e).map((s) => s.length));
	return out;
}

/** Keep each opening at its fraction of its segment: offset scales with the segment's length. */
function scaleOpenings(m: HouseModel, before: Map<string, number[]>): void {
	for (const e of m.elements) {
		if (!isOpening(e)) continue;
		const wall = findWall(m, e.host);
		const seg = wall ? segments(wall)[e.segment] : undefined;
		const old = before.get(e.host)?.[e.segment];
		if (!seg || old === undefined || old < EPS || seg.length < EPS) continue;
		if (Math.abs(seg.length - old) < 1e-9) continue;
		e.offset = round6((e.offset * seg.length) / old);
	}
}

/**
 * Move point `index` of a wall to `to`. Every shared corner moves with it (other walls, and the other
 * end of a closed loop). Each opening on a changed segment keeps its fraction offset / length.
 */
export function moveWallPoint(model: HouseModel, wallId: string, index: number, to: Vec2): HouseModel {
	const wall = findWall(model, wallId);
	if (!wall || index < 0 || index >= wall.points.length) return model;
	const next = structuredClone(model);
	const w = findWall(next, wallId)!;
	const before = oldSegLengths(next);
	const from = w.points[index];
	w.points[index] = [to[0], to[1]];
	// Every coincident point follows: other walls' corners, and a closed loop's other end.
	for (const e of next.elements) {
		if (!isWall(e)) continue;
		for (let j = 0; j < e.points.length; j++) {
			if (e.id === wallId && j === index) continue;
			if (samePoint(e.points[j], from)) e.points[j] = [to[0], to[1]];
		}
	}
	scaleOpenings(next, before);
	return next;
}

/**
 * Translate a whole wall by `delta`. Its openings keep segment and offset. A shared corner of another
 * wall moves with it (that wall stretches; its openings keep their fraction, as in moveWallPoint).
 */
export function moveWall(model: HouseModel, wallId: string, delta: Vec2): HouseModel {
	const wall = findWall(model, wallId);
	if (!wall) return model;
	const next = structuredClone(model);
	const w = findWall(next, wallId)!;
	const before = oldSegLengths(next);
	const originals = wall.points;
	w.points = w.points.map((p) => [p[0] + delta[0], p[1] + delta[1]] as Vec2);
	// A corner of another wall that sat on one of this wall's points follows the delta (the wall stretches).
	for (const e of next.elements) {
		if (!isWall(e) || e.id === wallId) continue;
		for (let j = 0; j < e.points.length; j++) {
			const p = e.points[j];
			if (originals.some((o) => samePoint(o, p))) e.points[j] = [p[0] + delta[0], p[1] + delta[1]];
		}
	}
	scaleOpenings(next, before);
	return next;
}

/**
 * Insert a point `at` into a wall, splitting segment `segment` in two (new point index segment + 1).
 * Openings on later segments get segment + 1. An opening on the split segment goes to the half that
 * holds its centre, with its offset measured from that half's start.
 */
export function insertWallPoint(model: HouseModel, wallId: string, segment: number, at: Vec2): HouseModel {
	const wall = findWall(model, wallId);
	const seg = wall ? segments(wall)[segment] : undefined;
	if (!wall || !seg) return model;
	const next = structuredClone(model);
	const w = findWall(next, wallId)!;
	w.points.splice(segment + 1, 0, [at[0], at[1]]);
	// Where the new point sits along the old segment: the split distance.
	const t = Math.max(0, Math.min(seg.length, (at[0] - seg.a[0]) * seg.dir[0] + (at[1] - seg.a[1]) * seg.dir[1]));
	for (const e of next.elements) {
		if (!isOpening(e) || e.host !== wallId) continue;
		if (e.segment < segment) continue;
		if (e.segment > segment) {
			e.segment += 1;
		} else if (e.offset > t) {
			e.segment = segment + 1;
			e.offset = round6(e.offset - t);
		}
	}
	return next;
}

/**
 * Move a window or door to the wall point nearest `to`. Another wall wins only when it is within
 * `radius` metres of `to` and nearer than the host; otherwise the opening slides on its host
 * (projection clamped to the segment, as nearestOnWall). Sets host, segment and offset.
 */
export function moveOpening(model: HouseModel, openingId: string, to: Vec2, radius = 0.8): HouseModel {
	const opening = model.elements.find((e): e is Opening => isOpening(e) && e.id === openingId);
	const hostWall = opening ? findWall(model, opening.host) : undefined;
	const host = hostWall ? nearestOnWall(hostWall, to) : null;
	if (!opening || !hostWall || !host) return model;
	// Rehost candidate: another wall within `radius` of `to` and strictly nearer than the host.
	let best: { wall: Wall; hit: NonNullable<ReturnType<typeof nearestOnWall>> } | null = null;
	for (const e of model.elements) {
		if (!isWall(e) || e.id === hostWall.id) continue;
		const hit = nearestOnWall(e, to);
		if (!hit || hit.distance > radius || hit.distance >= host.distance) continue;
		if (!best || hit.distance < best.hit.distance) best = { wall: e, hit };
	}
	const next = structuredClone(model);
	const o = next.elements.find((e): e is Opening => isOpening(e) && e.id === openingId)!;
	const target = best ?? { wall: hostWall, hit: host };
	o.host = target.wall.id;
	o.segment = target.hit.segment;
	o.offset = round6(target.hit.offset);
	return next;
}

/** Move a pool, box or item so its centre is `center`. Rotation and size unchanged. */
export function movePlaced(model: HouseModel, id: string, center: Vec2): HouseModel {
	if (!model.elements.some((e) => e.id === id && isPlaced(e))) return model;
	const next = structuredClone(model);
	(next.elements.find((e) => e.id === id && isPlaced(e)) as Extract<Element, { center: Vec2 }>).center = [center[0], center[1]];
	return next;
}

/** Set the rotation of a pool, box or item: rounded to a multiple of `step` degrees, normalised to [0, 360). */
export function rotatePlaced(model: HouseModel, id: string, degrees: number, step = 15): HouseModel {
	if (!model.elements.some((e) => e.id === id && isPlaced(e))) return model;
	const s = step > 0 ? step : 15;
	const rotation = round6((((Math.round(degrees / s) * s) % 360) + 360) % 360);
	const next = structuredClone(model);
	(next.elements.find((e) => e.id === id && isPlaced(e)) as Extract<Element, { center: Vec2 }>).rotation = rotation;
	return next;
}

/** Move point `index` of a slab outline to `to`. Null when the new outline is not a simple polygon. */
export function moveSlabPoint(model: HouseModel, slabId: string, index: number, to: Vec2): HouseModel | null {
	const slab = model.elements.find((e): e is Slab => e.type === 'slab' && e.id === slabId);
	if (!slab || index < 0 || index >= slab.outline.length) return model;
	const outline = slab.outline.map((p, i) => (i === index ? ([to[0], to[1]] as Vec2) : ([...p] as Vec2)));
	if (!isSimplePolygon(outline)) return null;
	const next = structuredClone(model);
	(next.elements.find((e): e is Slab => e.type === 'slab' && e.id === slabId)!).outline = outline;
	return next;
}
