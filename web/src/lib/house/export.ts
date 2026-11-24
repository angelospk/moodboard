// .glb export (glTF 2.0 binary): opens in Blender, 3ds Max, online viewers. Each element is one node
// named `type:id`; its glTF `extras` carry id, type, ifcClass and material id.
import { Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { buildHouse, disposeHouse } from './scene.js';
import type { HouseModel } from './model.js';

export async function toGlb(model: HouseModel): Promise<ArrayBuffer> {
	const scene = new Scene();
	scene.name = 'moodboard-house';
	const house = buildHouse(model);
	scene.add(house);
	try {
		const out = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true });
		if (!(out instanceof ArrayBuffer)) throw new Error('GLTFExporter did not return binary data');
		return out;
	} finally {
		disposeHouse(house);
	}
}

/** Save bytes or text as a file through a temporary link. */
export function download(data: BlobPart, filename: string, type: string) {
	const url = URL.createObjectURL(new Blob([data], { type }));
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name from a project name: letters, digits and dashes (Greek kept). */
export function fileBase(name: string): string {
	return name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'house';
}
