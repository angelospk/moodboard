// Meshes of catalog items (slice C). Parametric primitives only: each item kind is a few boxes,
// cylinders or cones that together fill the item's width × length × height box exactly.
import type { Group, MeshStandardMaterial } from 'three';
import type { Item } from './model.js';
import type { BuildOptions } from './scene.js';

/** Where buildItem gets its materials: one shared material per material id (scene.ts `Materials`). */
export interface MaterialSource {
	get(id: string): MeshStandardMaterial;
}

/** Rise of one stair step, in metres. */
export const STAIR_RISE = 0.175;

/** Number of risers of a straight stair of this height: Math.round(height / STAIR_RISE), at least 1. */
export function stairRisers(height: number): number {
	void height;
	throw new Error('not implemented');
}

/**
 * The three.js group of one item, placed in the world (plan centre, base elevation, rotation; axis map
 * as in scene.ts). Its axis-aligned bounding box, after rotation, is exactly the item's width × length ×
 * height box. Group name `item:<id>`, userData `{ id, type: 'item', kind, ifcClass: ITEM_IFC[kind],
 * material, name }`. A stair is one box per riser, each mesh named `step<i>` (i from 0). `opts.edges`
 * draws dark edges as the other builders do.
 */
export function buildItem(item: Item, mats: MaterialSource, opts: BuildOptions = {}): Group {
	void [item, mats, opts];
	throw new Error('not implemented');
}
