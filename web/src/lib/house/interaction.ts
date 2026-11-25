// Glue between the viewport's pointer input and the pure drag and snap modules. No DOM, no three.js:
// the viewport projects and raycasts; this file decides where a drag starts, how its points snap,
// and which part of the model the drag preview redraws.
import { snap } from './snap.js';
import type { Handle } from './handles.js';
import { round6, type Element, type HouseModel, type Vec2 } from './model.js';

/** Snap distance (metres) of a dragged or drawn point to wall corners, axes, faces and alignments. */
export const SNAP_RADIUS = 0.15;
/** While drawing, the points already placed catch the pointer from this far (to close a shape). */
export const DRAFT_RADIUS = 0.3;

const gridOnly = (p: Vec2, grid: number): Vec2 =>
	grid > 0 ? [round6(Math.round(p[0] / grid) * grid + 0), round6(Math.round(p[1] / grid) * grid + 0)] : [round6(p[0]), round6(p[1])];

/**
 * The part of a preview model the drag redraws, and the ids of the committed elements it replaces.
 * Walls: the affected ones plus the old and new hosts of affected openings. Every opening on those
 * walls comes along (holes and overlaps need them). Other affected elements come alone.
 */
export function previewScope(original: HouseModel, preview: HouseModel, affected: string[]): { model: HouseModel; hide: Set<string> } {
	const ids = new Set(affected);
	const walls = new Set<string>();
	for (const m of [original, preview]) {
		for (const e of m.elements) {
			if (!ids.has(e.id)) continue;
			if (e.type === 'wall') walls.add(e.id);
			else if (e.type === 'window' || e.type === 'door') walls.add(e.host);
		}
	}
	const keep = (e: Element) => ids.has(e.id) || walls.has(e.id) || ((e.type === 'window' || e.type === 'door') && walls.has(e.host));
	const elements = preview.elements.filter(keep);
	const hide = new Set([...elements.map((e) => e.id), ...original.elements.filter(keep).map((e) => e.id)]);
	return { model: { ...preview, elements }, hide };
}

/** Height (metres) where an element's handles sit and where its drag plane lies. */
export function handleElevation(el: Element, model: HouseModel): number {
	switch (el.type) {
		case 'wall':
			return el.base;
		case 'slab':
			return el.elevation;
		case 'box':
		case 'item':
			return el.base + el.height;
		case 'pool':
			return 0;
		case 'window':
		case 'door': {
			const host = model.elements.find((w) => w.id === el.host && w.type === 'wall');
			const sill = el.type === 'door' ? 0 : el.sill;
			return (host?.type === 'wall' ? host.base : 0) + sill + el.height / 2;
		}
	}
}

/** Plan point a DragSession starts from: the handle's own point, or for a wall body the press on the grid. */
export function dragStart(handle: Handle, press: Vec2, grid: number): Vec2 {
	return handle.kind === 'body' ? gridOnly(press, grid) : [handle.at[0], handle.at[1]];
}

/**
 * How a drag snaps its pointer points, or null for no snapping (an opening slides on its wall, a
 * rotate knob turns in 15° steps on its own). A wall body moves in whole grid steps. Every other
 * point snaps to the model (the dragged wall excluded), radius SNAP_RADIUS.
 */
export function dragSnapper(model: HouseModel, handle: Handle, grid: number): ((p: Vec2) => Vec2) | null {
	if (handle.kind === 'rotate') return null;
	const el = model.elements.find((e) => e.id === handle.element);
	if (!el || el.type === 'window' || el.type === 'door') return null;
	if (handle.kind === 'body') return (p) => gridOnly(p, grid);
	const exclude = el.type === 'wall' ? [el.id] : [];
	return (p) => snap(p, model, { grid, radius: SNAP_RADIUS, exclude }).point;
}

/** Snap a point while drawing: a point of the draft within DRAFT_RADIUS, else the model and the grid. */
export function drawSnap(p: Vec2, model: HouseModel, draft: Vec2[], grid: number): Vec2 {
	let best: Vec2 | null = null;
	let bestD = DRAFT_RADIUS;
	for (const q of draft) {
		const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
		if (d <= bestD) {
			bestD = d;
			best = q;
		}
	}
	if (best) return [best[0], best[1]];
	return snap(p, model, { grid, radius: SNAP_RADIUS }).point;
}

/** A typed wall length in metres ("3.2" or "3,2"), or null when it is not a length above 0 and up to 1000. */
export function typedLength(text: string): number | null {
	const t = text.trim().replace(',', '.');
	if (!/^\d+(\.\d+)?$|^\.\d+$/.test(t)) return null;
	const v = Number(t);
	return v > 0 && v <= 1000 ? v : null;
}
