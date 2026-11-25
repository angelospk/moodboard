// Snapping of a plan point while drawing or dragging (slice B). Pure functions.
//
// Order: a wall corner within `radius` wins. Then the nearest wall line within `radius`: the axis of
// a segment or one of its two faces (axis ± thickness / 2), measured to the segment, not the infinite
// line; the point is projected onto that line. Then alignment: x and/or y taken from a wall corner
// whose x (or y) is within `radius`, the other coordinate rounded to the grid. Else the grid.
// Every returned coordinate goes through round6.
import { round6, segments, type HouseModel, type Vec2, type Wall } from './model.js';

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
	const radius = opts.radius ?? 0.3;
	const grid = (v: number) => {
		if (opts.grid <= 0) return round6(v);
		return round6(Math.round(v / opts.grid) * opts.grid + 0); // + 0 turns -0 into 0
	};

	const walls = model.elements.filter((e): e is Wall => e.type === 'wall' && !opts.exclude?.includes(e.id));

	// 1. A wall corner within radius wins.
	let corner: Vec2 | null = null;
	let cornerD = radius;
	for (const w of walls) {
		for (const c of w.points) {
			const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
			if (d <= cornerD) {
				cornerD = d;
				corner = c;
			}
		}
	}
	if (corner) return { point: [corner[0], corner[1]], kind: 'corner' };

	// 2. The nearest wall line within radius: the axis of a segment or one of its two faces
	// (axis ± thickness / 2), measured to the segment, not the infinite line.
	let line: { ref: string; kind: 'axis' | 'face'; point: Vec2; d: number } | null = null;
	for (const w of walls) {
		const half = w.thickness / 2;
		for (const s of segments(w)) {
			if (!s.length) continue;
			const t = Math.max(0, Math.min(s.length, (p[0] - s.a[0]) * s.dir[0] + (p[1] - s.a[1]) * s.dir[1]));
			const proj: Vec2 = [s.a[0] + s.dir[0] * t, s.a[1] + s.dir[1] * t];
			for (const kind of ['axis', 'face'] as const) {
				for (const side of [0, -1, 1]) {
					if (kind === 'axis' && side !== 0) continue;
					if (kind === 'face' && side === 0) continue;
					const off = side * half;
					// Offset the projection perpendicular to the segment direction.
					const q: Vec2 = [round6(proj[0] - s.dir[1] * off), round6(proj[1] + s.dir[0] * off)];
					const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
					if (d <= radius && (!line || d < line.d)) line = { ref: w.id, kind, point: q, d };
				}
			}
		}
	}
	if (line) return { point: line.point, kind: line.kind, ref: line.ref };

	// 3. Alignment: x and/or y taken from a wall corner whose x (or y) is within radius.
	const corners = walls.flatMap((w) => w.points);
	const nearX = corners.filter((c) => Math.abs(c[0] - p[0]) <= radius).sort((a, b) => Math.abs(a[0] - p[0]) - Math.abs(b[0] - p[0]))[0];
	const nearY = corners.filter((c) => Math.abs(c[1] - p[1]) <= radius).sort((a, b) => Math.abs(a[1] - p[1]) - Math.abs(b[1] - p[1]))[0];
	if (nearX || nearY) return { point: [nearX ? round6(nearX[0]) : grid(p[0]), nearY ? round6(nearY[1]) : grid(p[1])], kind: 'align' };

	// 4. Else the grid.
	return { point: [grid(p[0]), grid(p[1])], kind: 'grid' };
}

/**
 * The point exactly `length` metres from `from` toward `cursor` (typed wall length). When cursor is
 * from, the direction is +x.
 */
export function pointAtLength(from: Vec2, cursor: Vec2, length: number): Vec2 {
	const dx = cursor[0] - from[0];
	const dy = cursor[1] - from[1];
	const len = Math.hypot(dx, dy);
	if (!len) return [round6(from[0] + length), round6(from[1])];
	return [round6(from[0] + (dx / len) * length), round6(from[1] + (dy / len) * length)];
}
