// The material library of the 3D editor. Ids are stable (they are stored in models and exported);
// `description` tells a person or an AI agent what the material stands for in a real building.

export interface HouseMaterial {
	id: string;
	name: { el: string; en: string };
	/** sRGB hex colour. */
	color: string;
	roughness: number;
	metalness: number;
	/** 1 = opaque. */
	opacity: number;
	/** Broad category, close to IFC material categories. */
	category: 'plaster' | 'concrete' | 'glass' | 'wood' | 'water' | 'ceramic' | 'masonry' | 'stone' | 'metal' | 'vegetation';
	description: string;
}

export const MATERIALS: HouseMaterial[] = [
	{ id: 'plaster_white', name: { el: 'Σοβάς λευκός', en: 'White plaster' }, color: '#eeebe4', roughness: 0.9, metalness: 0, opacity: 1, category: 'plaster', description: 'Painted render on a wall, off-white.' },
	{ id: 'plaster_warm', name: { el: 'Σοβάς ώχρα', en: 'Ochre plaster' }, color: '#d8b98a', roughness: 0.9, metalness: 0, opacity: 1, category: 'plaster', description: 'Painted render in a warm earth tone.' },
	{ id: 'concrete', name: { el: 'Εμφανές μπετό', en: 'Exposed concrete' }, color: '#a7a49d', roughness: 0.85, metalness: 0, opacity: 1, category: 'concrete', description: 'Cast-in-place reinforced concrete left exposed.' },
	{ id: 'glass', name: { el: 'Γυαλί', en: 'Glass' }, color: '#9fc4d6', roughness: 0.05, metalness: 0, opacity: 0.35, category: 'glass', description: 'Clear double glazing in a window or glass door.' },
	{ id: 'wood_oak', name: { el: 'Ξύλο δρυς', en: 'Oak wood' }, color: '#a8794a', roughness: 0.7, metalness: 0, opacity: 1, category: 'wood', description: 'Oak timber: doors, cladding, decking.' },
	{ id: 'wood_dark', name: { el: 'Ξύλο σκούρο', en: 'Dark wood' }, color: '#5e4330', roughness: 0.7, metalness: 0, opacity: 1, category: 'wood', description: 'Dark stained timber (walnut tone).' },
	{ id: 'pool_water', name: { el: 'Νερό πισίνας', en: 'Pool water' }, color: '#3fa7c9', roughness: 0.1, metalness: 0, opacity: 0.8, category: 'water', description: 'Water in a swimming pool with light tiles below.' },
	{ id: 'roof_tile', name: { el: 'Κεραμίδι', en: 'Roof tile' }, color: '#b4532a', roughness: 0.8, metalness: 0, opacity: 1, category: 'ceramic', description: 'Terracotta roof tiles.' },
	{ id: 'brick', name: { el: 'Τούβλο', en: 'Brick' }, color: '#9c5a43', roughness: 0.9, metalness: 0, opacity: 1, category: 'masonry', description: 'Exposed clay brick masonry.' },
	{ id: 'stone', name: { el: 'Πέτρα', en: 'Stone' }, color: '#8f877a', roughness: 0.95, metalness: 0, opacity: 1, category: 'stone', description: 'Natural local stone masonry.' },
	{ id: 'marble', name: { el: 'Μάρμαρο', en: 'Marble' }, color: '#e4e1da', roughness: 0.3, metalness: 0, opacity: 1, category: 'stone', description: 'White marble paving or cladding.' },
	{ id: 'steel_dark', name: { el: 'Ατσάλι σκούρο', en: 'Dark steel' }, color: '#3b3d40', roughness: 0.45, metalness: 0.6, opacity: 1, category: 'metal', description: 'Dark painted steel or aluminium frames.' },
	{ id: 'grass', name: { el: 'Γρασίδι', en: 'Grass' }, color: '#6b8a4a', roughness: 1, metalness: 0, opacity: 1, category: 'vegetation', description: 'Lawn or planted ground.' }
];

const byId = new Map(MATERIALS.map((m) => [m.id, m]));

/** The material with this id, or white plaster when the id is unknown. */
export function material(id: string): HouseMaterial {
	return byId.get(id) ?? MATERIALS[0];
}
