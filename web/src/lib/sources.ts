// The «Πηγές» page: images grouped by the website (and page) they were saved from.
import type { Inspiration } from '#lib/types.js';

export interface SourcePage {
	url: string;
	title: string | null;
	items: Inspiration[];
}

export interface Source {
	/** Site name without `www.`, lowercase (e.g. archdaily.com). */
	host: string;
	items: Inspiration[];
	/** Distinct pages of the site, most images first. */
	pages: SourcePage[];
	/** Projects of the site's images (null = no project), most images first. */
	projects: { id: string | null; count: number }[];
	/** Newest created_at among the images. */
	last: string;
}

export type SourceSort = 'count' | 'recent';

/** The site of a web page address, or null for anything that is not an http(s) page. */
export function hostOf(url: string | null | undefined): string | null {
	if (!url) return null;
	try {
		const u = new URL(url);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
		return u.hostname.toLowerCase().replace(/^www\./, '') || null;
	} catch {
		return null;
	}
}

/** Lowercase without accents, so «μαρμαρο» finds «Μάρμαρο». */
export function fold(s: string): string {
	return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** One key per page: no `www.`, no `#…`, no trailing slash. */
function pageKey(url: string): string {
	const u = new URL(url);
	return hostOf(url) + u.pathname.replace(/\/$/, '') + u.search;
}

const byCount = <T extends { count: number }>(a: T, b: T) => b.count - a.count;

export function groupSources(items: Inspiration[], sort: SourceSort = 'count'): { sources: Source[]; unsourced: Inspiration[] } {
	const sites = new Map<string, Inspiration[]>();
	const unsourced: Inspiration[] = [];
	for (const i of items) {
		const host = hostOf(i.source_url);
		if (!host) unsourced.push(i);
		else sites.set(host, [...(sites.get(host) ?? []), i]);
	}
	const sources: Source[] = [...sites].map(([host, rows]) => {
		const pages = new Map<string, SourcePage>();
		const projects = new Map<string | null, number>();
		let last = '';
		for (const i of rows) {
			const key = pageKey(i.source_url!);
			const p = pages.get(key) ?? { url: i.source_url!, title: null, items: [] };
			p.title ??= i.source_title;
			p.items.push(i);
			pages.set(key, p);
			projects.set(i.project_id, (projects.get(i.project_id) ?? 0) + 1);
			if (i.created_at > last) last = i.created_at;
		}
		return {
			host,
			items: rows,
			pages: [...pages.values()].sort((a, b) => b.items.length - a.items.length),
			projects: [...projects].map(([id, count]) => ({ id, count })).sort(byCount),
			last
		};
	});
	sources.sort((a, b) =>
		sort === 'recent'
			? b.last.localeCompare(a.last)
			: b.items.length - a.items.length || b.last.localeCompare(a.last)
	);
	return { sources, unsourced };
}

export interface SourceFilter {
	query?: string;
	/** undefined = every project; null = only images without a project. */
	project?: string | null;
	tag?: string | null;
}

export function filterItems(items: Inspiration[], f: SourceFilter): Inspiration[] {
	const q = fold(f.query?.trim() ?? '');
	return items.filter((i) => {
		if (f.project !== undefined && i.project_id !== f.project) return false;
		if (f.tag && !i.tags.includes(f.tag)) return false;
		if (!q) return true;
		const text = [i.source_url ?? '', i.source_title ?? '', i.note, ...i.tags, ...i.regions.map((r) => r.note ?? '')].join(' ');
		return fold(text).includes(q);
	});
}
