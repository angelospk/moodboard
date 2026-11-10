export const LEVELS = ['urban', 'building', 'interior', 'detail', 'material'] as const;
export type Level = (typeof LEVELS)[number];

/** A marked detail on an image. Coordinates are fractions (0..1) of the image size. */
export interface Region {
	x: number;
	y: number;
	w: number;
	h: number;
	note: string;
}

export interface Project {
	id: string;
	name: string;
	description: string;
	created_at: string;
}

export interface Inspiration {
	id: string;
	project_id: string | null;
	image_path: string;
	source_url: string | null;
	source_title: string | null;
	note: string;
	tags: string[];
	level: Level | null;
	regions: Region[];
	created_at: string;
	updated_at: string;
}

export const BUCKET = 'inspirations';
