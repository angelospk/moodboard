// Smart search: search by meaning, similar images, label suggestions from neighbours, duplicates and
// the project description draft. Every call needs the server's embedding key and the user's consent;
// without them the server answers `enabled: false` (or ready: false) and nothing is shown.
import type PocketBase from 'pocketbase';

export interface Hit {
	id: string;
	score: number;
}

export interface SearchResult {
	/** False when the user has not agreed, or the server has no key. */
	enabled: boolean;
	results: Hit[];
}

/** Why a call returned nothing, for a message: the daily limit, or any other failure. */
export class SmartSearchError extends Error {
	constructor(
		readonly kind: 'limit' | 'failed',
		message: string
	) {
		super(message);
	}
}

async function call<T>(pb: PocketBase, path: string, options: { method?: string; query?: Record<string, string> } = {}): Promise<T> {
	try {
		return await pb.send<T>(path, { requestKey: null, ...options });
	} catch (e) {
		const status = (e as { status?: number }).status;
		throw new SmartSearchError(status === 429 ? 'limit' : 'failed', (e as Error).message ?? '');
	}
}

/** Images that match a description ("warm minimal living room"), best first. One model call. */
export function searchByMeaning(pb: PocketBase, q: string, project = ''): Promise<SearchResult> {
	const query: Record<string, string> = { q };
	if (project) query.project = project;
	return call<SearchResult>(pb, '/api/mb/search', { query });
}

export interface SimilarResult {
	/** False while the image has no vector yet. */
	ready: boolean;
	results: Hit[];
}

/** Images that look like image `id`: of its own project, or of all projects. No model call. */
export function similarTo(pb: PocketBase, id: string, scope: 'project' | 'all', limit = 12): Promise<SimilarResult> {
	return call<SimilarResult>(pb, `/api/mb/inspirations/${encodeURIComponent(id)}/similar`, { query: { scope, limit: String(limit) } });
}

export interface KnnSuggestion {
	ready: boolean;
	/** A level id of the user, or null. */
	level: string | null;
	tags: string[];
}

/** A level and tags from the labels of the most similar images. No model call. */
export function knnSuggest(pb: PocketBase, id: string): Promise<KnnSuggestion> {
	return call<KnnSuggestion>(pb, `/api/mb/inspirations/${encodeURIComponent(id)}/knn-suggest`);
}

/** The ids of images that show almost the same picture as `id`. */
export async function duplicatesOf(pb: PocketBase, id: string): Promise<string[]> {
	const out = await call<{ pairs: { a: string; b: string }[] }>(pb, '/api/mb/duplicates', { query: { id } });
	return out.pairs.map((p) => (p.a === id ? p.b : p.a));
}

export interface EmbedStatus {
	/** The server can embed (it has the key). */
	enabled: boolean;
	/** The user agreed. */
	consent: boolean;
	total: number;
	embedded: number;
}

export function embedStatus(pb: PocketBase): Promise<EmbedStatus> {
	return call<EmbedStatus>(pb, '/api/mb/embed/status');
}

/** Save the user's choice: all their images may be sent once to the AI to compute an embedding. */
export async function setEmbedEnabled(pb: PocketBase, userId: string, on: boolean): Promise<void> {
	await pb.collection('users').update(userId, { embed_enabled: on });
}

/** A piece of the project description: fixed text, or places where the AI offers 2 or 3 readings. */
export interface DraftPart {
	text?: string;
	choices?: string[];
}

export interface Draft {
	enabled: boolean;
	parts: DraftPart[];
}

/** Ask the AI for a draft description of a project. Only when the user presses the button. */
export function draftSummary(pb: PocketBase, projectId: string): Promise<Draft> {
	return call<Draft>(pb, `/api/mb/projects/${encodeURIComponent(projectId)}/summary-draft`, { method: 'POST' });
}

/** The draft text for the readings the user picked (`picks`: part index -> choice index; default the first). */
export function composeDraft(parts: DraftPart[], picks: Record<number, number>): string {
	return parts
		.map((p, i) => {
			if (!p.choices?.length) return p.text ?? '';
			const k = picks[i];
			return p.choices[k !== undefined && k >= 0 && k < p.choices.length ? k : 0];
		})
		.join('');
}
