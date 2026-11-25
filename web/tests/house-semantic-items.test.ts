// Slice D: items in the semantic JSON (src/lib/house/semantic.ts) and its schema
// (docs/house-3d-schema.json, published copy in static/schemas/).
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { toSemantic } from '../src/lib/house/semantic';
import { emptyModel, ITEM_DEFAULTS, type HouseModel, type Item, type ItemKind } from '../src/lib/house/model';

const schema = JSON.parse(readFileSync(new URL('../../docs/house-3d-schema.json', import.meta.url), 'utf8'));
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

const item = (id: string, kind: ItemKind, over: Partial<Item> = {}): Item => {
	const d = ITEM_DEFAULTS[kind];
	return { id, type: 'item', kind, name: '', material: d.material, center: [0, 0], width: d.width, length: d.length, height: d.height, base: 0, rotation: 0, ...over };
};

const withItems: HouseModel = {
	...emptyModel(),
	elements: [
		{ id: 'w1', type: 'wall', name: '', material: 'plaster_white', points: [[0, 0], [6, 0]], height: 3, thickness: 0.25, base: 0 },
		item('bed1', 'bed', { center: [2, 3], width: 1.6, length: 2, height: 0.5, rotation: 90 }),
		item('wc1', 'wc', { center: [5, 1] }),
		item('tree1', 'tree', { center: [12, 8] }),
		item('car1', 'car', { center: [10, -3] }),
		item('st1', 'stair', { center: [1, 1], base: 0.2 })
	]
};

// A v1 house with every element type except items (the same as house-export.test.ts).
const v1: HouseModel = {
	...emptyModel(),
	elements: [
		{ id: 'w1', type: 'wall', name: 'Βόρειος τοίχος', material: 'plaster_white', points: [[0, 0], [6, 0], [6, 4]], height: 3, thickness: 0.25, base: 0 },
		{ id: 'win1', type: 'window', name: '', material: 'glass', host: 'w1', segment: 0, offset: 4, width: 1.2, height: 1.4, sill: 0.9 },
		{ id: 'd1', type: 'door', name: '', material: 'wood_oak', host: 'w1', segment: 1, offset: 2, width: 0.9, height: 2.1, sill: 0 },
		{ id: 's1', type: 'slab', name: '', material: 'concrete', outline: [[0, 0], [6, 0], [6, 4], [0, 4]], elevation: 0, thickness: 0.2 },
		{ id: 'p1', type: 'pool', name: '', material: 'pool_water', center: [10, 2], width: 3, length: 6, depth: 1.5, rotation: 90 },
		{ id: 'b1', type: 'box', name: '', material: 'roof_tile', center: [3, 2], width: 6, length: 4, height: 0.5, base: 3, rotation: 0 }
	]
};

describe('semantic items', () => {
	it('items export with ifcClass per kind', () => {
		const by = Object.fromEntries(toSemantic(withItems).elements.map((e) => [e.id, e]));
		expect(by.bed1).toMatchObject({ type: 'item', ifcClass: 'IfcFurniture', objectType: 'bed', material: { id: 'wood_oak' } });
		expect(by.wc1).toMatchObject({ type: 'item', ifcClass: 'IfcSanitaryTerminal', objectType: 'wc' });
		expect(by.tree1).toMatchObject({ type: 'item', ifcClass: 'IfcGeographicElement', objectType: 'tree' });
		expect(by.car1).toMatchObject({ type: 'item', ifcClass: 'IfcBuildingElementProxy', objectType: 'car' });
		expect(by.st1).toMatchObject({ type: 'item', ifcClass: 'IfcStair', objectType: 'stair' });
		// Geometry as stored; placement: centre at the base elevation, direction of the rotated +x axis.
		expect(by.bed1.geometry).toEqual({ kind: 'bed', center: [2, 3], width: 1.6, length: 2, height: 0.5, base: 0, rotation: 90 });
		expect(by.bed1.placement).toEqual({ point: [2, 3, 0], direction: [0, 1, 0] });
		expect(by.st1.placement).toEqual({ point: [1, 1, 0.2], direction: [1, 0, 0] });
		expect(by.bed1.quantities).toEqual({ width: 1.6, length: 2, height: 0.5 });
	});

	it('the doc with items passes the schema', () => {
		const doc = toSemantic(withItems, { name: 'Σπίτι' });
		const ok = validate(doc);
		expect(validate.errors ?? []).toEqual([]);
		expect(ok).toBe(true);
		// The schema knows the kinds: an unknown one fails.
		const bed = doc.elements.find((e) => e.id === 'bed1');
		expect(bed).toBeDefined();
		if (!bed) return;
		const piano = { ...bed, objectType: 'piano', geometry: { ...bed.geometry, kind: 'piano' } };
		expect(validate({ ...doc, elements: [piano] })).toBe(false);
		// ... and the class must match the kind.
		expect(validate({ ...doc, elements: [{ ...bed, ifcClass: 'IfcStair' }] })).toBe(false);
	});

	it('a v1 doc without items is unchanged (snapshot)', () => {
		expect(toSemantic(v1, { name: 'Σπίτι' })).toMatchSnapshot();
	});
});
