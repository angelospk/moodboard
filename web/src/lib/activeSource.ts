// «Προσθέτεις από»: a web page (and source project) that every image the user adds gets, until the
// user stops it or an hour passes without use. Pure; activeSource.svelte.ts keeps it per browser.
import type { Inspiration } from '#lib/types.js';
import { cleanSourceProject, commonSourceProject } from '#lib/sourceProjects.js';
import { itemsOfPage } from '#lib/sources.js';

export interface ActiveSource {
	/** The web page (http or https). */
	url: string;
	/** The source project, or null. */
	project: string | null;
	/** Last use (start or an image added), ms since epoch. */
	at: number;
}

/** A source not used for this long lapses, so a forgotten one does not label tomorrow's images. */
export const ACTIVE_SOURCE_TTL = 60 * 60 * 1000;

/** One http(s) page address with a real host, or null. */
function pageUrl(text: string): string | null {
	if (!/^https?:\/\/\S+$/i.test(text)) return null;
	try {
		const u = new URL(text);
		return u.hostname.includes('.') ? text : null;
	} catch {
		return null;
	}
}

/** A stored source, checked; null when missing or malformed. */
export function parseActiveSource(raw: string | null): ActiveSource | null {
	if (!raw) return null;
	try {
		const v: unknown = JSON.parse(raw);
		if (!v || typeof v !== 'object') return null;
		const { url, project, at } = v as Record<string, unknown>;
		if (typeof url !== 'string' || !pageUrl(url)) return null;
		if (project !== null && typeof project !== 'string') return null;
		if (typeof at !== 'number' || !Number.isFinite(at)) return null;
		return { url, project: cleanSourceProject(project), at };
	} catch {
		return null;
	}
}

/** The source while it is live, else null. */
export function liveSource(a: ActiveSource | null, now: number): ActiveSource | null {
	return a && now - a.at < ACTIVE_SOURCE_TTL ? a : null;
}

/** Pasted text that is one web page address and nothing else (it starts a source), or null. */
export function pastedPageUrl(text: string): string | null {
	return pageUrl(text.trim());
}

/** The source project the images of page `url` already have (most used), or null. */
export function nameForPage(items: Inspiration[], url: string): string | null {
	return commonSourceProject(itemsOfPage(items, url)).name;
}

/** The fields a new image gets from a live source (none without one). */
export function sourceFields(a: ActiveSource | null): { source_url?: string; source_project?: string | null } {
	return a ? { source_url: a.url, source_project: a.project } : {};
}
