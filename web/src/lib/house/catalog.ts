// The item catalog of the 3D editor (slice C): one entry per ITEM_KINDS kind, in that order.
// Sizes and materials come from ITEM_DEFAULTS and IFC classes from ITEM_IFC (model.ts).
import { ITEM_DEFAULTS, ITEM_IFC, ITEM_KINDS, newElementId, type Item, type ItemIfcClass, type ItemKind, type Vec2 } from './model.js';

/** Picker group of an item kind. */
export type CatalogGroup = 'furniture' | 'sanitary' | 'site' | 'circulation';

export interface CatalogEntry {
	kind: ItemKind;
	/** Message key of the item's name; Editor/messages add the texts (F2). */
	i18nKey: `house.item.${ItemKind}`;
	group: CatalogGroup;
	ifcClass: ItemIfcClass;
	/** Default size in metres (width along x, length along y, before rotation) and material id. */
	width: number;
	length: number;
	height: number;
	material: string;
}

/** Picker group of each kind. */
const GROUPS: Record<ItemKind, CatalogGroup> = {
	bed: 'furniture',
	sofa: 'furniture',
	table: 'furniture',
	chair: 'furniture',
	counter: 'furniture',
	wc: 'sanitary',
	basin: 'sanitary',
	shower: 'sanitary',
	bath: 'sanitary',
	tree: 'site',
	car: 'site',
	stair: 'circulation'
};

function entry(kind: ItemKind): CatalogEntry {
	return { kind, i18nKey: `house.item.${kind}`, group: GROUPS[kind], ifcClass: ITEM_IFC[kind], ...ITEM_DEFAULTS[kind] };
}

/** All entries, one per kind, in ITEM_KINDS order. A new array each call. */
export function catalog(): CatalogEntry[] {
	return ITEM_KINDS.map(entry);
}

/** The entry of one kind. */
export function catalogEntry(kind: ItemKind): CatalogEntry {
	return entry(kind);
}

/** A new item of this kind at `center` (rotation in degrees), with the catalog defaults, base 0, empty name and a fresh id. */
export function newItem(kind: ItemKind, center: Vec2, rotation = 0): Item {
	const d = ITEM_DEFAULTS[kind];
	return {
		id: newElementId(),
		type: 'item',
		kind,
		name: '',
		material: d.material,
		center: [center[0], center[1]],
		rotation,
		base: 0,
		width: d.width,
		length: d.length,
		height: d.height
	};
}
