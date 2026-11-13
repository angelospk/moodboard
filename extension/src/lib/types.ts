/** The id of one of the user's levels (collection "levels"). */
export type Level = string;

export interface LevelRow {
	id: string;
	name: string;
}

export interface Project {
	id: string;
	name: string;
	description: string;
	created_at: string;
	archived?: boolean;
}

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
