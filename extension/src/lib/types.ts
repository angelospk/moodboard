export const LEVELS = ['urban', 'building', 'interior', 'detail', 'material'] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_LABELS: Record<Level, string> = {
	urban: 'Πόλη',
	building: 'Κτίριο',
	interior: 'Εσωτερικό',
	detail: 'Λεπτομέρεια',
	material: 'Υλικό',
};

export interface Project {
	id: string;
	name: string;
	description: string;
	created_at: string;
}

export const BUCKET = 'inspirations';

export const MIME_EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/avif': 'avif',
};

/** Normalize a mime string: lowercase, strip parameters. */
export function normalizeMime(mime: string): string {
	return mime.split(';')[0]!.trim().toLowerCase();
}

/** Parse comma separated tags: trim, lowercase, dedupe, drop empty, max 30. */
export function parseTags(input: string): string[] {
	const seen = new Set<string>();
	for (const raw of input.split(',')) {
		const tag = raw.trim().toLowerCase();
		if (!tag) continue;
		seen.add(tag);
		if (seen.size >= 30) break;
	}
	return [...seen];
}
