// Slice C: item catalog (src/lib/house/catalog.ts) and item meshes (src/lib/house/items3d.ts).
import { describe, expect, it } from 'vitest';
import { Box3, Mesh, MeshStandardMaterial, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { catalog, catalogEntry, newItem } from '../src/lib/house/catalog';
import { buildItem, stairRisers } from '../src/lib/house/items3d';
import { toGlb } from '../src/lib/house/export';
import { emptyModel, ITEM_DEFAULTS, ITEM_IFC, ITEM_KINDS, type HouseModel, type Item } from '../src/lib/house/model';

// Node has Blob but no FileReader; GLTFExporter's binary path reads Blobs with it (as in house-export.test.ts).
if (typeof globalThis.FileReader === 'undefined') {
	class NodeFileReader {
		result: ArrayBuffer | string | null = null;
		onloadend: (() => void) | null = null;
		readAsArrayBuffer(b: Blob) {
			void b.arrayBuffer().then((r) => { this.result = r; this.onloadend?.(); });
		}
		readAsDataURL(b: Blob) {
			void b.arrayBuffer().then((r) => {
				this.result = `data:${b.type || 'application/octet-stream'};base64,${Buffer.from(r).toString('base64')}`;
				this.onloadend?.();
			});
		}
	}
	(globalThis as { FileReader?: unknown }).FileReader = NodeFileReader;
}

const mats = { get: (id: string) => new MeshStandardMaterial({ name: id }) };

const item = (over: Partial<Item> & Pick<Item, 'id' | 'kind'>): Item => {
	const d = ITEM_DEFAULTS[over.kind];
	return { type: 'item', name: '', material: d.material, center: [0, 0], width: d.width, length: d.length, height: d.height, base: 0, rotation: 0, ...over };
};

describe('catalog', () => {
	it('every ITEM_KIND has a catalog entry with an i18n key, IFC class and sizes', () => {
		const all = catalog();
		expect(all.map((e) => e.kind)).toEqual([...ITEM_KINDS]);
		for (const kind of ITEM_KINDS) {
			const e = catalogEntry(kind);
			expect(e).toMatchObject({ kind, i18nKey: `house.item.${kind}`, ifcClass: ITEM_IFC[kind], ...ITEM_DEFAULTS[kind] });
			expect(['furniture', 'sanitary', 'site', 'circulation']).toContain(e.group);
		}
		expect(catalogEntry('wc').group).toBe('sanitary');
		expect(catalogEntry('sofa').group).toBe('furniture');
		expect(catalogEntry('tree').group).toBe('site');
		expect(catalogEntry('car').group).toBe('site');
		expect(catalogEntry('stair').group).toBe('circulation');
		expect(catalogEntry('bed')).toMatchObject({ width: 1.6, length: 2, height: 0.5, ifcClass: 'IfcFurniture' });

		const a = newItem('sofa', [3, 4], 90);
		const b = newItem('sofa', [3, 4]);
		expect(a).toMatchObject({ type: 'item', kind: 'sofa', name: '', center: [3, 4], rotation: 90, base: 0, width: 2.2, length: 0.9, height: 0.85, material: 'plaster_warm' });
		expect(b.rotation).toBe(0);
		expect(a.id).not.toBe(b.id);
	});

	it('buildItem bounding box equals width×height×length after rotation', () => {
		// Sofa 2 × 1 × 0.8 at (3, 4), base 0.5, turned 90°: plan x spans the length, plan y the width.
		// Three.js: plan (x, y) at elevation z → (x, z, -y).
		const g = buildItem(item({ id: 's', kind: 'sofa', center: [3, 4], width: 2, length: 1, height: 0.8, base: 0.5, rotation: 90 }), mats);
		expect(g.name).toBe('item:s');
		expect(g.userData).toMatchObject({ id: 's', type: 'item', kind: 'sofa', ifcClass: 'IfcFurniture', material: 'plaster_warm' });
		const box = new Box3().setFromObject(g);
		expect(box.min.x).toBeCloseTo(2.5, 3);
		expect(box.max.x).toBeCloseTo(3.5, 3);
		expect(box.min.y).toBeCloseTo(0.5, 3);
		expect(box.max.y).toBeCloseTo(1.3, 3);
		expect(box.min.z).toBeCloseTo(-5, 3);
		expect(box.max.z).toBeCloseTo(-3, 3);
		// Every kind fills its own box exactly (unrotated, at the origin).
		for (const kind of ITEM_KINDS) {
			const d = ITEM_DEFAULTS[kind];
			const b = new Box3().setFromObject(buildItem(item({ id: kind, kind }), mats));
			expect([b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map((v) => +v.toFixed(3)), kind).toEqual([d.width, d.height, d.length]);
			expect(b.min.y, kind).toBeCloseTo(0, 3);
		}
	});

	it('stair riser count = round(height/0.175)', () => {
		expect(stairRisers(3)).toBe(17);
		expect(stairRisers(2.8)).toBe(16);
		expect(stairRisers(0.05)).toBe(1);
		const g = buildItem(item({ id: 'st', kind: 'stair', height: 3 }), mats);
		const steps: Object3D[] = [];
		g.traverse((o) => { if (o instanceof Mesh && o.name.startsWith('step')) steps.push(o); });
		expect(steps).toHaveLength(17);
		expect(steps.map((s) => s.name)).toContain('step16');
	});

	it('glb has one node item:<id> per item', async () => {
		const m: HouseModel = { ...emptyModel(), elements: [
			{ id: 'w', type: 'wall', name: '', material: 'concrete', points: [[0, 0], [6, 0]], height: 3, thickness: 0.25, base: 0 },
			item({ id: 'bed1', kind: 'bed', center: [2, 2] }),
			item({ id: 'car1', kind: 'car', center: [10, 2], rotation: 90 })
		] };
		const glb = await toGlb(m);
		// Node names as written in the file (GLTFLoader strips the ':' when it reads them back).
		const view = new DataView(glb);
		const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, view.getUint32(12, true)))) as { nodes: { name?: string }[] };
		expect(json.nodes.map((n) => n.name).filter((n) => n?.startsWith('item:')).sort()).toEqual(['item:bed1', 'item:car1']);
		const gltf = await new GLTFLoader().parseAsync(glb, '');
		const items = new Map<string, Object3D>();
		gltf.scene.traverse((o) => { if (o.userData?.type === 'item') items.set(o.userData.id as string, o); });
		expect([...items.keys()].sort()).toEqual(['bed1', 'car1']);
		expect(items.get('bed1')!.userData).toMatchObject({ kind: 'bed', ifcClass: 'IfcFurniture', material: 'wood_oak' });
		expect(items.get('car1')!.userData).toMatchObject({ kind: 'car', ifcClass: 'IfcBuildingElementProxy' });
	});
});
