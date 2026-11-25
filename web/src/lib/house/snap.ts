// Snapping of a plan point while drawing or dragging (slice B). Pure functions.
//
// Order: a wall corner within `radius` wins. Then the nearest wall line within `radius`: the axis of
// a segment or one of its two faces (axis ± thickness / 2), measured to the segment, not the infinite
// line; the point is projected onto that line. Then alignment: x and/or y taken from a wall corner
// whose x (or y) is within `radius`, the other coordinate rounded to the grid. Else the grid.
// Every returned coordinate goes through round6.
import type { HouseModel, Vec2 } from './model.js';

export type SnapKind = 'corner' | 'axis' | 'face' | 'align' | 'grid';

export interface SnapOptions {
	/** Grid step in metres; 0 leaves the point as it is when nothing else snaps. */
	grid: number;
	/** Snap distance in metres. Default 0.3. */
	radius?: number;
	/** Ids of walls to ignore (the ones being dragged). */
	exclude?: string[];
}

export interface SnapResult {
	point: Vec2;
	kind: SnapKind;
	/** Id of the wall that gave the corner, axis or face (not set for align and grid). */
	ref?: string;
}

/** Snap `p` to the model's walls, else to the grid (order in the file header). */
export function snap(p: Vec2, model: HouseModel, opts: SnapOptions): SnapResult {
	void [p, model, opts];
	throw new Error('not implemented');
}

/**
 * The point exactly `length` metres from `from` toward `cursor` (typed wall length). When cursor is
 * from, the direction is +x.
 */
export function pointAtLength(from: Vec2, cursor: Vec2, length: number): Vec2 {
	void [from, cursor, length];
	throw new Error('not implemented');
}
