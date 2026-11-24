// Exports of the house model: the semantic JSON (checked against docs/house-3d-schema.json) and the
// .glb (read back with three's GLTFLoader).
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Mesh, MeshStandardMaterial, Object3D } from 'three';
import { toSemantic } from '../src/lib/house/semantic';
import { toGlb } from '../src/lib/house/export';
import { emptyModel, type HouseModel } from '../src/lib/house/model';

// Node has Blob but no FileReader; GLTFExporter's binary path reads Blobs with it.
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

const schema = JSON.parse(readFileSync(new URL('../../docs/house-3d-schema.json', import.meta.url), 'utf8'));

const house: HouseModel = {
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

describe('semantic JSON', () => {
	const doc = toSemantic(house, { name: 'Σπίτι' });
	const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

	it('passes the published schema', () => {
		const ok = validate(doc);
		expect(validate.errors ?? []).toEqual([]);
		expect(ok).toBe(true);
	});

	it('says its units, axes and schema', () => {
		expect(doc).toMatchObject({ schema: 'moodboard.house/v1', name: 'Σπίτι', units: { length: 'm', angle: 'deg' } });
		expect(doc.coordinateSystem).toMatch(/z up/i);
	});

	it('uses IFC class names and keeps types and materials readable', () => {
		const by = Object.fromEntries(doc.elements.map((e) => [e.id, e]));
		expect(by.w1).toMatchObject({ type: 'wall', ifcClass: 'IfcWall', material: { id: 'plaster_white', name: 'White plaster', color: '#eeebe4' } });
		expect(by.win1).toMatchObject({ type: 'window', ifcClass: 'IfcWindow', hostId: 'w1' });
		expect(by.d1).toMatchObject({ type: 'door', ifcClass: 'IfcDoor', hostId: 'w1' });
		expect(by.s1).toMatchObject({ ifcClass: 'IfcSlab' });
		expect(by.p1.ifcClass).toBe('IfcBuildingElementProxy');
		expect(by.b1.ifcClass).toBe('IfcBuildingElementProxy');
	});

	it('gives quantities and absolute placements so an agent need not compute them', () => {
		const by = Object.fromEntries(doc.elements.map((e) => [e.id, e]));
		expect(by.w1.quantities).toMatchObject({ length: 10, height: 3, thickness: 0.25 });
		// Window 4 m along the first segment (0,0)→(6,0), 0.9 m above the wall bottom.
		expect(by.win1.placement).toEqual({ point: [4, 0, 0.9], direction: [1, 0, 0] });
		// Door 2 m along the second segment (6,0)→(6,4).
		expect(by.d1.placement).toEqual({ point: [6, 2, 0], direction: [0, 1, 0] });
		expect(by.s1.quantities).toMatchObject({ area: 24, thickness: 0.2 });
		expect(by.p1.quantities).toMatchObject({ area: 18, depth: 1.5 });
	});

	it('an invalid document fails the schema', () => {
		expect(validate({ ...doc, elements: [{ id: 'x', type: 'wall' }] })).toBe(false);
		const door = doc.elements.find((e) => e.type === 'door')!;
		const raised = { ...door, geometry: { ...(door as { geometry: object }).geometry, sill: 0.9 } };
		expect(validate({ ...doc, elements: [raised] })).toBe(false);
	});

	it('the schema the export points to is published with the app, same as docs/', () => {
		expect(doc.$schema).toBe('https://moodboard.haroldpoi.dev/schemas/house-3d-schema.json');
		const published = JSON.parse(readFileSync(new URL('../static/schemas/house-3d-schema.json', import.meta.url), 'utf8'));
		expect(published).toEqual(schema);
	});
});

describe('glb', () => {
	it('reads back with GLTFLoader: one named node per element, materials kept', async () => {
		const glb = await toGlb(house);
		expect(glb).toBeInstanceOf(ArrayBuffer);
		expect(new TextDecoder().decode(new Uint8Array(glb, 0, 4))).toBe('glTF');

		const gltf = await new GLTFLoader().parseAsync(glb, '');
		const named = new Map<string, Object3D>();
		gltf.scene.traverse((o) => { if (o.userData?.id) named.set(o.userData.id as string, o); });
		expect([...named.keys()].sort()).toEqual(['b1', 'd1', 'p1', 's1', 'w1', 'win1']);
		expect(named.get('w1')!.userData).toMatchObject({ type: 'wall', ifcClass: 'IfcWall', material: 'plaster_white' });

		const meshes: Mesh[] = [];
		named.get('b1')!.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
		expect(meshes.length).toBeGreaterThan(0);
		const m = meshes[0].material as MeshStandardMaterial;
		expect(m.name).toBe('roof_tile');
		expect('#' + m.color.getHexString()).toBe('#b4532a');
	});

	it('an opening the wall has no hole for gets no panel', async () => {
		const clash: HouseModel = { ...emptyModel(), elements: [
			house.elements[0],
			{ id: 'a', type: 'window', name: '', material: 'glass', host: 'w1', segment: 0, offset: 3, width: 1.2, height: 1.4, sill: 0.9 },
			{ id: 'b', type: 'window', name: '', material: 'glass', host: 'w1', segment: 0, offset: 3.4, width: 1.2, height: 1.4, sill: 0.9 }
		] };
		const gltf = await new GLTFLoader().parseAsync(await toGlb(clash), '');
		const ids: string[] = [];
		gltf.scene.traverse((o) => { if (o.userData?.id) ids.push(o.userData.id as string); });
		expect(ids.sort()).toEqual(['a', 'w1']);
	});

	it('Y up: a 3 m wall reaches y = 3, and plan y maps to -z', async () => {
		const gltf = await new GLTFLoader().parseAsync(await toGlb(house), '');
		const { Box3 } = await import('three');
		let w: Object3D | undefined;
		gltf.scene.traverse((o) => { if (o.userData?.id === 'w1') w = o; });
		const box = new Box3().setFromObject(w!);
		expect(box.max.y).toBeCloseTo(3, 3);
		expect(box.min.y).toBeCloseTo(0, 3);
		expect(box.min.z).toBeLessThan(-3.9); // the segment (6,0)→(6,4) runs toward -z
	});
});
