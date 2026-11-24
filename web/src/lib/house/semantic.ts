// The semantic JSON export: a self-documenting description of the house, so an AI agent (or a
// person) can rebuild it in Revit, ArchiCAD or ZWCAD. Described by docs/house-3d-schema.json.
// All lengths in metres, angles in degrees; every number is rounded to 6 decimals.
import { material } from './materials';
import { round6, segments, type Element, type HouseModel, type Opening, type Vec2, type Wall } from './model';

export type Vec3 = [number, number, number];

export interface SemanticMaterial {
	id: string;
	name: string;
	color: string;
	category: string;
	description: string;
}

/** One exported element. Fields beyond the common ones depend on `type` (see the JSON schema). */
export interface SemanticElement {
	id: string;
	type: Element['type'];
	ifcClass: 'IfcWall' | 'IfcSlab' | 'IfcWindow' | 'IfcDoor' | 'IfcBuildingElementProxy';
	/** Only for the proxies: what the IfcBuildingElementProxy stands for. */
	objectType?: 'SwimmingPool' | 'Volume';
	name: string;
	material: SemanticMaterial;
	/** Windows and doors: id of the host wall. */
	hostId?: string;
	/** Walls: ids of the windows and doors in the wall. */
	openingIds?: string[];
	geometry: Record<string, unknown>;
	/** Windows and doors: absolute position and direction. */
	placement?: { point: Vec3; direction: Vec3 };
	quantities: Record<string, number>;
}

export interface SemanticDoc {
	$schema: string;
	schema: 'moodboard.house/v1';
	name: string;
	units: { length: 'm'; angle: 'deg' };
	coordinateSystem: string;
	generator: string;
	elements: SemanticElement[];
}

export const SEMANTIC_SCHEMA_URL = 'https://moodboard.haroldpoi.dev/schemas/house-3d-schema.json';

const r = round6;
const r2 = (p: Vec2): Vec2 => [r(p[0]), r(p[1])];

function mat(id: string): SemanticMaterial {
	const m = material(id);
	return { id: m.id, name: m.name.en, color: m.color, category: m.category, description: m.description };
}

function shoelace(outline: Vec2[]): number {
	let s = 0;
	for (let i = 0; i < outline.length; i++) {
		const a = outline[i];
		const b = outline[(i + 1) % outline.length];
		s += a[0] * b[1] - b[0] * a[1];
	}
	return Math.abs(s) / 2;
}

function perimeter(outline: Vec2[]): number {
	let s = 0;
	for (let i = 0; i < outline.length; i++) {
		const a = outline[i];
		const b = outline[(i + 1) % outline.length];
		s += Math.hypot(b[0] - a[0], b[1] - a[1]);
	}
	return s;
}

function wallElement(w: Wall, openings: Opening[]): SemanticElement {
	const length = segments(w).reduce((s, g) => s + g.length, 0);
	return {
		id: w.id,
		type: 'wall',
		ifcClass: 'IfcWall',
		name: w.name,
		material: mat(w.material),
		geometry: { points: w.points.map(r2), base: r(w.base), height: r(w.height), thickness: r(w.thickness), axis: 'centerline' },
		quantities: {
			length: r(length),
			height: r(w.height),
			thickness: r(w.thickness),
			grossSideArea: r(length * w.height),
			volume: r(length * w.height * w.thickness)
		},
		openingIds: openings.filter((o) => o.host === w.id).map((o) => o.id)
	};
}

function openingElement(o: Opening, wall: Wall | undefined): SemanticElement | null {
	const seg = wall ? segments(wall)[o.segment] : undefined;
	if (!wall || !seg) return null;
	return {
		id: o.id,
		type: o.type,
		ifcClass: o.type === 'window' ? 'IfcWindow' : 'IfcDoor',
		name: o.name,
		material: mat(o.material),
		hostId: o.host,
		geometry: { segment: o.segment, offset: r(o.offset), width: r(o.width), height: r(o.height), sill: r(o.sill) },
		placement: {
			point: [r(seg.a[0] + seg.dir[0] * o.offset), r(seg.a[1] + seg.dir[1] * o.offset), r(wall.base + o.sill)],
			direction: [r(seg.dir[0]), r(seg.dir[1]), 0]
		},
		quantities: { area: r(o.width * o.height) }
	};
}

export function toSemantic(model: HouseModel, meta: { name?: string } = {}): SemanticDoc {
	const walls = new Map(model.elements.filter((e): e is Wall => e.type === 'wall').map((w) => [w.id, w]));
	const openings = model.elements.filter((e): e is Opening => e.type === 'window' || e.type === 'door');
	const elements: SemanticElement[] = [];
	for (const e of model.elements) {
		if (e.type === 'wall') elements.push(wallElement(e, openings));
		else if (e.type === 'window' || e.type === 'door') {
			const x = openingElement(e, walls.get(e.host));
			if (x) elements.push(x);
		} else if (e.type === 'slab') {
			elements.push({
				id: e.id,
				type: 'slab',
				ifcClass: 'IfcSlab',
				name: e.name,
				material: mat(e.material),
				geometry: { outline: e.outline.map(r2), elevation: r(e.elevation), thickness: r(e.thickness) },
				quantities: {
					area: r(shoelace(e.outline)),
					perimeter: r(perimeter(e.outline)),
					thickness: r(e.thickness),
					volume: r(shoelace(e.outline) * e.thickness)
				}
			});
		} else if (e.type === 'pool') {
			elements.push({
				id: e.id,
				type: 'pool',
				ifcClass: 'IfcBuildingElementProxy',
				objectType: 'SwimmingPool',
				name: e.name,
				material: mat(e.material),
				geometry: { center: r2(e.center), width: r(e.width), length: r(e.length), rotation: r(e.rotation), depth: r(e.depth) },
				quantities: { area: r(e.width * e.length), depth: r(e.depth), volume: r(e.width * e.length * e.depth) }
			});
		} else if (e.type === 'box') {
			elements.push({
				id: e.id,
				type: 'box',
				ifcClass: 'IfcBuildingElementProxy',
				objectType: 'Volume',
				name: e.name,
				material: mat(e.material),
				geometry: { center: r2(e.center), width: r(e.width), length: r(e.length), rotation: r(e.rotation), base: r(e.base), height: r(e.height) },
				quantities: { area: r(e.width * e.length), height: r(e.height), volume: r(e.width * e.length * e.height) }
			});
		}
	}
	return {
		$schema: SEMANTIC_SCHEMA_URL,
		schema: 'moodboard.house/v1',
		name: meta.name ?? '',
		units: { length: 'm', angle: 'deg' },
		coordinateSystem: 'right-handed, z up; plan x east, y north; elevations in z; ground at z = 0',
		generator: 'moodboard 3D editor',
		elements
	};
}
