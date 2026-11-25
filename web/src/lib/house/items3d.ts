// Meshes of catalog items (slice C). Parametric primitives only: each item kind is a few boxes,
// cylinders or cones that together fill the item's width × length × height box exactly.
//
// Local frame of an item (before the group is placed): x across the width, y up from the base,
// z along the length. scene.ts maps plan (x, y) at elevation z to world (x, z, -y) and turns the
// group by `rotation` degrees about Y.
import {
	BoxGeometry,
	BufferGeometry,
	ConeGeometry,
	CylinderGeometry,
	EdgesGeometry,
	Group,
	LineBasicMaterial,
	LineSegments,
	Mesh,
	MeshStandardMaterial
} from 'three';
import { ITEM_IFC, type Item } from './model.js';
import type { BuildOptions } from './scene.js';

/** Where buildItem gets its materials: one shared material per material id (scene.ts `Materials`). */
export interface MaterialSource {
	get(id: string): MeshStandardMaterial;
}

/** Rise of one stair step, in metres. */
export const STAIR_RISE = 0.175;

/** Number of risers of a straight stair of this height: Math.round(height / STAIR_RISE), at least 1. */
export function stairRisers(height: number): number {
	return Math.max(1, Math.round(height / STAIR_RISE));
}

const edgeMaterial = new LineBasicMaterial({ color: 0x2b2a27, transparent: true, opacity: 0.45 });

function part(geo: BufferGeometry, mat: MeshStandardMaterial, opts: BuildOptions, name: string): Mesh {
	const m = new Mesh(geo, mat);
	m.name = name;
	m.castShadow = mat.opacity >= 1;
	m.receiveShadow = true;
	if (opts.edges) {
		const e = new LineSegments(new EdgesGeometry(geo, 25), edgeMaterial);
		e.userData.edges = true;
		e.raycast = () => {}; // edges must not catch clicks
		m.add(e);
	}
	return m;
}

/** Box spanning x [cx ± sx/2], y [y0, y1], z [cz ± sz/2] in the item's local frame. */
function box(sx: number, y0: number, y1: number, sz: number, cx = 0, cz = 0): BoxGeometry {
	const geo = new BoxGeometry(sx, y1 - y0, sz);
	geo.translate(cx, (y0 + y1) / 2, cz);
	return geo;
}

/** A straight flight: one box per riser, from the floor up to the full stair height. */
function stair(item: Item, mat: MeshStandardMaterial, opts: BuildOptions): Mesh[] {
	const n = stairRisers(item.height);
	const rise = item.height / n;
	const going = item.length / n;
	const steps: Mesh[] = [];
	for (let i = 0; i < n; i++) {
		// Local z runs along the flight; step i rises from i·rise to (i+1)·rise.
		const geo = box(item.width, i * rise, (i + 1) * rise, going, 0, -item.length / 2 + (i + 0.5) * going);
		steps.push(part(geo, mat, opts, `step${i}`));
	}
	return steps;
}

/** The meshes of one item kind; together they touch all six faces of its box. */
function parts(item: Item, mat: MeshStandardMaterial, opts: BuildOptions): Mesh[] {
	const w = item.width;
	const l = item.length;
	const h = item.height;
	switch (item.kind) {
		case 'bed': {
			const head = Math.min(0.15, l / 4);
			return [
				part(box(w, 0, h * 0.4, l), mat, opts, 'frame'),
				part(box(w, h * 0.4, h * 0.75, l - head, 0, -head / 2), mat, opts, 'mattress'),
				part(box(w, 0, h, head, 0, l / 2 - head / 2), mat, opts, 'headboard')
			];
		}
		case 'sofa': {
			const arm = Math.min(0.2, w / 4);
			const back = Math.min(0.2, l / 3);
			return [
				part(box(w, 0, h * 0.35, l), mat, opts, 'base'),
				part(box(w, h * 0.35, h, back, 0, l / 2 - back / 2), mat, opts, 'back'),
				part(box(arm, 0, h * 0.7, l, -w / 2 + arm / 2), mat, opts, 'arm-left'),
				part(box(arm, 0, h * 0.7, l, w / 2 - arm / 2), mat, opts, 'arm-right')
			];
		}
		case 'table': {
			const top = h * 0.07;
			const leg = 0.08;
			const meshes = [part(box(w, h - top, h, l), mat, opts, 'top')];
			for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
				meshes.push(part(box(leg, 0, h - top, leg, sx * (w / 2 - leg * 2), sz * (l / 2 - leg * 2)), mat, opts, 'leg'));
			}
			return meshes;
		}
		case 'chair': {
			const seat = h * 0.47;
			const leg = 0.05;
			const back = 0.05;
			const meshes = [
				part(box(w, seat - leg, seat, l), mat, opts, 'seat'),
				part(box(w, seat, h, back, 0, l / 2 - back / 2), mat, opts, 'back')
			];
			for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
				meshes.push(part(box(leg, 0, seat - leg, leg, sx * (w / 2 - leg), sz * (l / 2 - leg)), mat, opts, 'leg'));
			}
			return meshes;
		}
		case 'counter': {
			const top = Math.min(0.04, h / 4);
			return [
				part(box(w, 0, h - top, l), mat, opts, 'cabinet'),
				part(box(w, h - top, h, l), mat, opts, 'top')
			];
		}
		case 'wc': {
			const tank = Math.min(0.2, l / 3);
			return [
				part(box(w, 0, h * 0.5, l - tank, 0, -tank / 2), mat, opts, 'bowl'),
				part(box(w, h * 0.5, h, tank, 0, l / 2 - tank / 2), mat, opts, 'tank')
			];
		}
		case 'basin': {
			const bowl = Math.min(0.2, h / 3);
			const ped = Math.min(0.15, w / 2, l / 2);
			return [
				part(box(w, h - bowl, h, l), mat, opts, 'bowl'),
				part(box(ped, 0, h - bowl, ped), mat, opts, 'pedestal')
			];
		}
		case 'shower': {
			const tray = Math.min(0.05, h / 10);
			const panel = 0.02;
			return [
				part(box(w, 0, tray, l), mat, opts, 'tray'),
				part(box(w, tray, h, panel, 0, l / 2 - panel / 2), mat, opts, 'wall-back'),
				part(box(panel, tray, h, l, -w / 2 + panel / 2), mat, opts, 'wall-left'),
				part(box(panel, tray, h, l, w / 2 - panel / 2), mat, opts, 'wall-right')
			];
		}
		case 'bath': {
			const floor = h * 0.2;
			const wall = 0.1;
			return [
				part(box(w, 0, floor, l), mat, opts, 'bottom'),
				part(box(w, floor, h, wall, 0, -l / 2 + wall / 2), mat, opts, 'side-near'),
				part(box(w, floor, h, wall, 0, l / 2 - wall / 2), mat, opts, 'side-far'),
				part(box(wall, floor, h, l, -w / 2 + wall / 2), mat, opts, 'side-left'),
				part(box(wall, floor, h, l, w / 2 - wall / 2), mat, opts, 'side-right')
			];
		}
		case 'tree': {
			const trunk = h * 0.3;
			const meshes = [
				part(new CylinderGeometry(Math.min(0.15, w / 4), Math.min(0.2, w / 3), trunk, 12).translate(0, trunk / 2, 0), mat, opts, 'trunk')
			];
			// A cone over the trunk: its base ring reaches the full width and length.
			meshes.push(part(new ConeGeometry(Math.min(w, l) / 2, h - trunk, 12).translate(0, trunk + (h - trunk) / 2, 0), mat, opts, 'crown'));
			return meshes;
		}
		case 'car': {
			const wheel = Math.min(0.35, h / 4);
			const bodyBottom = wheel * 0.6;
			const bodyTop = h * 0.55;
			const cabin = Math.min(0.45, l * 0.45);
			const meshes = [
				part(box(w, bodyBottom, bodyTop, l), mat, opts, 'body'),
				part(box(w * 0.8, bodyTop, h, cabin, 0, -l * 0.05), mat, opts, 'cabin')
			];
			for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
				const geo = new CylinderGeometry(wheel, wheel, 0.15, 12).rotateZ(Math.PI / 2);
				geo.translate(sx * (w / 2 - 0.075), wheel, sz * (l / 2 - l * 0.2));
				meshes.push(part(geo, mat, opts, 'wheel'));
			}
			return meshes;
		}
		case 'stair':
			return stair(item, mat, opts);
	}
}

/**
 * The three.js group of one item, placed in the world (plan centre, base elevation, rotation; axis map
 * as in scene.ts). Its axis-aligned bounding box, after rotation, is exactly the item's width × length ×
 * height box. Group name `item:<id>`, userData `{ id, type: 'item', kind, ifcClass: ITEM_IFC[kind],
 * material, name }`. A stair is one box per riser, each mesh named `step<i>` (i from 0). `opts.edges`
 * draws dark edges as the other builders do.
 */
export function buildItem(item: Item, mats: MaterialSource, opts: BuildOptions = {}): Group {
	const g = new Group();
	g.name = `item:${item.id}`;
	g.userData = { id: item.id, type: 'item', kind: item.kind, ifcClass: ITEM_IFC[item.kind], material: item.material, name: item.name };
	const mat = mats.get(item.material);
	for (const p of parts(item, mat, opts)) g.add(p);
	g.position.set(item.center[0], item.base, -item.center[1]);
	g.rotation.y = (item.rotation * Math.PI) / 180; // counter-clockwise seen from above, as in the plan
	return g;
}
