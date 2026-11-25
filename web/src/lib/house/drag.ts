// Drag operations of the 3D editor (slice A). Pure functions on HouseModel: they never mutate their
// input and return a new model (or null when the change is refused). An unknown id returns the input
// model unchanged. They do not snap, fit or validate openings: the caller snaps the target point, and
// commit() runs parseModel (fitOpening) and the hidesOpening check on the result.
//
// Shared corner: a point of another wall (or of the same wall) within 1e-6 m of the moved point.
import type { HouseModel, Vec2 } from './model.js';

/**
 * Move point `index` of a wall to `to`. Every shared corner moves with it (other walls, and the other
 * end of a closed loop). Each opening on a changed segment keeps its fraction offset / length.
 */
export function moveWallPoint(model: HouseModel, wallId: string, index: number, to: Vec2): HouseModel {
	void [model, wallId, index, to];
	throw new Error('not implemented');
}

/**
 * Translate a whole wall by `delta`. Its openings keep segment and offset. A shared corner of another
 * wall moves with it (that wall stretches; its openings keep their fraction, as in moveWallPoint).
 */
export function moveWall(model: HouseModel, wallId: string, delta: Vec2): HouseModel {
	void [model, wallId, delta];
	throw new Error('not implemented');
}

/**
 * Insert a point `at` into a wall, splitting segment `segment` in two (new point index segment + 1).
 * Openings on later segments get segment + 1. An opening on the split segment goes to the half that
 * holds its centre, with its offset measured from that half's start.
 */
export function insertWallPoint(model: HouseModel, wallId: string, segment: number, at: Vec2): HouseModel {
	void [model, wallId, segment, at];
	throw new Error('not implemented');
}

/**
 * Move a window or door to the wall point nearest `to`. Another wall wins only when it is within
 * `radius` metres of `to` and nearer than the host; otherwise the opening slides on its host
 * (projection clamped to the segment, as nearestOnWall). Sets host, segment and offset.
 */
export function moveOpening(model: HouseModel, openingId: string, to: Vec2, radius = 0.8): HouseModel {
	void [model, openingId, to, radius];
	throw new Error('not implemented');
}

/** Move a pool, box or item so its centre is `center`. Rotation and size unchanged. */
export function movePlaced(model: HouseModel, id: string, center: Vec2): HouseModel {
	void [model, id, center];
	throw new Error('not implemented');
}

/** Set the rotation of a pool, box or item: rounded to a multiple of `step` degrees, normalised to [0, 360). */
export function rotatePlaced(model: HouseModel, id: string, degrees: number, step = 15): HouseModel {
	void [model, id, degrees, step];
	throw new Error('not implemented');
}

/** Move point `index` of a slab outline to `to`. Null when the new outline is not a simple polygon. */
export function moveSlabPoint(model: HouseModel, slabId: string, index: number, to: Vec2): HouseModel | null {
	void [model, slabId, index, to];
	throw new Error('not implemented');
}
