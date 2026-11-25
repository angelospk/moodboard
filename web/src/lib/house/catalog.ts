// The item catalog of the 3D editor (slice C): one entry per ITEM_KINDS kind, in that order.
// Sizes and materials come from ITEM_DEFAULTS and IFC classes from ITEM_IFC (model.ts).
import type { Item, ItemIfcClass, ItemKind, Vec2 } from './model.js';

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

/** All entries, one per kind, in ITEM_KINDS order. A new array each call. */
export function catalog(): CatalogEntry[] {
	throw new Error('not implemented');
}

/** The entry of one kind. */
export function catalogEntry(kind: ItemKind): CatalogEntry {
	void kind;
	throw new Error('not implemented');
}

/** A new item of this kind at `center` (rotation in degrees), with the catalog defaults, base 0, empty name and a fresh id. */
export function newItem(kind: ItemKind, center: Vec2, rotation = 0): Item {
	void [kind, center, rotation];
	throw new Error('not implemented');
}
