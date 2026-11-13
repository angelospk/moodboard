/** The id of one of the user's levels (see levels.ts). */
export type Level = string;

/** A marked detail on an image. Coordinates are fractions (0..1) of the image size. */
export interface Region {
	x: number;
	y: number;
	w: number;
	h: number;
	note: string;
	/** 1 = not this, 5 = exactly this; null/absent = not rated. */
	rating?: number | null;
	/** Freeform outline (closed polygon, fractions 0..1 of the image). x/y/w/h are then its bounding box. */
	points?: [number, number][];
}

/** The part of an image that cards show. Fractions (0..1) of the image size; the file is not changed. */
export interface Crop {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Level and tags the user's own AI proposed (MCP tool suggest_labels); applied only on accept. */
export interface Suggestion {
	level: Level | null;
	tags: string[];
}

export interface Project {
	id: string;
	name: string;
	description: string;
	/** Put away by the owner: hidden from the project list and pickers, images kept. */
	archived: boolean;
	created_at: string;
}

export interface Inspiration {
	id: string;
	project_id: string | null;
	image_path: string;
	source_url: string | null;
	source_title: string | null;
	/** The image's own address on the web (from the extension); source_url is the page. */
	image_url: string | null;
	crop: Crop | null;
	note: string;
	tags: string[];
	level: Level | null;
	regions: Region[];
	/** Pending AI suggestion, or null. */
	suggestion: Suggestion | null;
	/** Dominant colors as #rrggbb, most common first (the server computes them). */
	colors: string[];
	created_at: string;
	updated_at: string;
}

export const BUCKET = 'inspirations';
