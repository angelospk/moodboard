// Build three.js objects from a house model. The same builder feeds the editor and the .glb export,
// so what the user sees is what Blender opens.
//
// Axes: a plan point [x, y] at elevation z becomes (x, z, -y) in three.js (Y up, like glTF).
import {
	BoxGeometry,
	BufferGeometry,
	DoubleSide,
	EdgesGeometry,
	ExtrudeGeometry,
	Group,
	LineBasicMaterial,
	LineSegments,
	Matrix4,
	Mesh,
	MeshStandardMaterial,
	Path,
	Shape,
	Vector2,
	Vector3,
	type Object3D
} from 'three';
import { material as findMaterial } from './materials.js';
import { buildItem } from './items3d.js';
import {
	cutIds,
	isClosed,
	OPENING_MARGIN,
	openingsOf,
	segments,
	wallFace,
	type Box,
	type Element,
	type HouseModel,
	type Opening,
	type Pool,
	type Slab,
	type Vec2,
	type Wall
} from './model.js';

export const IFC_CLASS: Record<Element['type'], string> = {
	wall: 'IfcWall',
	slab: 'IfcSlab',
	window: 'IfcWindow',
	door: 'IfcDoor',
	pool: 'IfcBuildingElementProxy',
	box: 'IfcBuildingElementProxy',
	// Fallback only: an item's real class is ITEM_IFC[kind] (model.ts), set by buildItem.
	item: 'IfcBuildingElementProxy'
};

/** Glass and door leaves are this thick. */
const PANEL = 0.04;

export interface BuildOptions {
	/** Draw dark edges on every mesh (editor only; the export leaves them out). */
	edges?: boolean;
}

/** One material per material id, shared by all meshes of a build. */
class Materials {
	#cache = new Map<string, MeshStandardMaterial>();
	get(id: string): MeshStandardMaterial {
		let m = this.#cache.get(id);
		if (!m) {
			const def = findMaterial(id);
			m = new MeshStandardMaterial({
				name: def.id,
				color: def.color,
				roughness: def.roughness,
				metalness: def.metalness,
				transparent: def.opacity < 1,
				opacity: def.opacity,
				// Glass and water are seen from both sides; a single face would vanish from behind.
				side: def.opacity < 1 ? DoubleSide : undefined,
				depthWrite: def.opacity >= 1
			});
			this.#cache.set(id, m);
		}
		return m;
	}
}

const edgeMaterial = new LineBasicMaterial({ color: 0x2b2a27, transparent: true, opacity: 0.45 });

function mesh(geometry: BufferGeometry, mat: MeshStandardMaterial, opts: BuildOptions): Mesh {
	const m = new Mesh(geometry, mat);
	m.castShadow = mat.opacity >= 1;
	m.receiveShadow = true;
	if (opts.edges) {
		const e = new LineSegments(new EdgesGeometry(geometry, 25), edgeMaterial);
		e.userData.edges = true;
		e.raycast = () => {}; // edges must not catch clicks
		m.add(e);
	}
	return m;
}

function holder(e: Element): Group {
	const g = new Group();
	g.name = `${e.type}:${e.id}`;
	g.userData = { id: e.id, type: e.type, ifcClass: IFC_CLASS[e.type], material: e.material, name: e.name };
	return g;
}

/** Frame of one wall segment: u along it, v up, w across (right-handed), origin at plan point `a`. */
function segmentFrame(a: Vec2, dir: Vec2, base: number): Matrix4 {
	const u = new Vector3(dir[0], 0, -dir[1]);
	const v = new Vector3(0, 1, 0);
	const w = new Vector3().crossVectors(u, v);
	return new Matrix4().makeBasis(u, v, w).setPosition(a[0], base, -a[1]);
}


/** Builds the wall with holes for the given openings (only ones cutIds accepted). */
function buildWall(w: Wall, openings: Opening[], mats: Materials, opts: BuildOptions): Group {
	const g = holder(w);
	const segs = segments(w);
	const loop = isClosed(w.points);
	for (const s of segs) {
		if (s.length < 0.01) continue;
		// Extend into each joint by half the thickness, so corners close without a gap.
		const ext0 = s.index > 0 || loop ? w.thickness / 2 : 0;
		const ext1 = s.index < segs.length - 1 || loop ? w.thickness / 2 : 0;
		const own = openings.filter((o) => o.segment === s.index).map((o) => ({ ...o, offset: o.offset + ext0 }));
		const face = wallFace(s.length + ext0 + ext1, w.height, own);
		const shape = new Shape(face.outline.map(([u, v]) => new Vector2(u, v)));
		for (const h of face.holes) shape.holes.push(new Path(h.map(([u, v]) => new Vector2(u, v))));
		const geo = new ExtrudeGeometry(shape, { depth: w.thickness, bevelEnabled: false });
		geo.translate(-ext0, 0, -w.thickness / 2);
		geo.applyMatrix4(segmentFrame(s.a, s.dir, w.base));
		const m = mesh(geo, mats.get(w.material), opts);
		m.name = `${g.name}:seg${s.index}`;
		g.add(m);
	}
	return g;
}

function buildOpening(o: Opening, wall: Wall, mats: Materials, opts: BuildOptions): Group {
	const g = holder(o);
	const s = segments(wall)[o.segment];
	if (!s) return g;
	const sill = o.type === 'door' ? 0 : o.sill; // as in wallFace
	const top = Math.min(sill + o.height, wall.height - OPENING_MARGIN); // the hole's clipped top, as in wallFace
	const geo = new BoxGeometry(o.width, top - sill, PANEL);
	geo.translate(o.offset, (sill + top) / 2, 0);
	geo.applyMatrix4(segmentFrame(s.a, s.dir, wall.base));
	g.add(mesh(geo, mats.get(o.material), opts));
	return g;
}

function buildSlab(sl: Slab, mats: Materials, opts: BuildOptions): Group {
	const g = holder(sl);
	const geo = new ExtrudeGeometry(new Shape(sl.outline.map(([x, y]) => new Vector2(x, y))), { depth: sl.thickness, bevelEnabled: false });
	// Plan (x, y, up) → three (x, up, -y): a -90° turn about X.
	geo.rotateX(-Math.PI / 2);
	geo.translate(0, sl.elevation - sl.thickness, 0);
	g.add(mesh(geo, mats.get(sl.material), opts));
	return g;
}

function place(o: Object3D, center: Vec2, y: number, rotation: number) {
	o.position.set(center[0], y, -center[1]);
	o.rotation.y = (rotation * Math.PI) / 180; // counter-clockwise seen from above, as in the plan
}

function buildPool(p: Pool, mats: Materials, opts: BuildOptions): Group {
	const g = holder(p);
	// The water fills the basin up to just above the ground, so it reads on an opaque ground plane.
	const top = 0.02;
	const m = mesh(new BoxGeometry(p.width, p.depth + top, p.length), mats.get(p.material), opts);
	m.position.y = (top - p.depth) / 2;
	g.add(m);
	place(g, p.center, 0, p.rotation);
	return g;
}

function buildBox(b: Box, mats: Materials, opts: BuildOptions): Group {
	const g = holder(b);
	g.add(mesh(new BoxGeometry(b.width, b.height, b.length), mats.get(b.material), opts));
	place(g, b.center, b.base + b.height / 2, b.rotation);
	return g;
}

/** A group with one child group per element (name `type:id`, userData with id, type, ifcClass, material). */
export function buildHouse(model: HouseModel, opts: BuildOptions = {}): Group {
	const root = new Group();
	root.name = 'house';
	const mats = new Materials();
	const walls = new Map(model.elements.filter((e): e is Wall => e.type === 'wall').map((w) => [w.id, w]));
	// An opening its wall cannot cut (it overlaps another) gets neither a hole nor a panel.
	const cut = cutIds(model);
	for (const e of model.elements) {
		let g: Group | null = null;
		if (e.type === 'wall') g = buildWall(e, openingsOf(model, e.id).filter((o) => cut.has(o.id)), mats, opts);
		else if (e.type === 'window' || e.type === 'door') {
			const w = walls.get(e.host);
			if (w && cut.has(e.id)) g = buildOpening(e, w, mats, opts);
		} else if (e.type === 'slab') g = buildSlab(e, mats, opts);
		else if (e.type === 'pool') g = buildPool(e, mats, opts);
		else if (e.type === 'box') g = buildBox(e, mats, opts);
		else if (e.type === 'item') g = buildItem(e, mats, opts);
		if (g) root.add(g);
	}
	return root;
}

/** Free the geometries and materials of a built house (edge material is shared and kept). */
export function disposeHouse(root: Object3D) {
	const mats = new Set<MeshStandardMaterial>();
	root.traverse((o) => {
		if (o instanceof Mesh || o instanceof LineSegments) o.geometry.dispose();
		if (o instanceof Mesh) mats.add(o.material as MeshStandardMaterial);
	});
	for (const m of mats) m.dispose();
}

/** Plan point of a three.js world point (inverse of the axis map). */
export function toPlan(v: { x: number; z: number }): Vec2 {
	return [v.x, -v.z];
}
