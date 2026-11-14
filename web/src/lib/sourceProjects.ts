// The «source project» of an image: the work it was taken from (a case study, a portfolio piece),
// typed by the user. It is not one of the user's own moodboard projects (project_id) and not the
// web page (source_url). Everything here is pure; the pages do the saving.
import type { Inspiration } from '#lib/types.js';
import { fold, hostOf, pageKey } from '#lib/sources.js';

export const SOURCE_PROJECT_MAX = 200;

/** The name as it is stored: trimmed, inner spaces collapsed, at most 200 characters. Null when empty. */
export function cleanSourceProject(text: string | null | undefined): string | null {
	const s = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, SOURCE_PROJECT_MAX).trim();
	return s || null;
}

/** Two spellings of one name (case, accents, spaces) share this key. */
export function nameKey(name: string): string {
	return fold(name).replace(/\s+/g, ' ').trim();
}

/** Count the names of `items` by key; the display spelling is the most used one (first seen on a tie). */
function tally(items: Pick<Inspiration, 'source_project'>[]) {
	const keys = new Map<string, { spellings: Map<string, number>; count: number }>();
	for (const i of items) {
		const name = cleanSourceProject(i.source_project);
		if (!name) continue;
		const k = nameKey(name);
		const e = keys.get(k) ?? { spellings: new Map<string, number>(), count: 0 };
		e.count++;
		e.spellings.set(name, (e.spellings.get(name) ?? 0) + 1);
		keys.set(k, e);
	}
	return [...keys].map(([key, e]) => ({
		key,
		count: e.count,
		name: [...e.spellings].reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0]
	}));
}

const byCountThenName = (a: { count: number; name: string }, b: { count: number; name: string }) =>
	b.count - a.count || a.name.localeCompare(b.name);

/** Every name in use, for autocomplete: most used first, then alphabetical. */
export function sourceProjectNames(items: Pick<Inspiration, 'source_project'>[]): string[] {
	return tally(items).sort(byCountThenName).map((e) => e.name);
}

export interface SourceProjectSection {
	/** The name key; '' for the images without a source project. */
	key: string;
	name: string;
	items: Inspiration[];
}

/**
 * One section per source project, biggest first (then alphabetical), the images without one last.
 * `ranked` (search by meaning): the images arrive best result first; sections follow their best
 * result and each keeps that order.
 */
export function groupBySourceProject(
	items: Inspiration[],
	opts: { noneName: string; ranked?: boolean }
): SourceProjectSection[] {
	const names = new Map(tally(items).map((e) => [e.key, e.name]));
	const sections = new Map<string, SourceProjectSection>();
	const none: Inspiration[] = [];
	for (const i of items) {
		const name = cleanSourceProject(i.source_project);
		if (!name) {
			none.push(i);
			continue;
		}
		const key = nameKey(name);
		const sec = sections.get(key) ?? { key, name: names.get(key)!, items: [] };
		sec.items.push(i);
		sections.set(key, sec);
	}
	const named = [...sections.values()];
	// Map insertion order = order of each section's first (= best ranked) image.
	if (!opts.ranked) named.sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
	if (none.length) named.push({ key: '', name: opts.noneName, items: none });
	return named;
}

export interface SourceProjectSuggestion {
	/** The page key (see sources.ts); keeps a dismissal. */
	key: string;
	/** The page the images share. */
	url: string;
	/** Images without a source project that are on that page. */
	ids: string[];
	/** The name to offer: an existing one the page's other images already have, else the page title, else the site. */
	name: string;
	/** True when `name` is one the page's other images already have. */
	existing: boolean;
}

/**
 * Batches of images without a source project that share a web page. Never applied by itself.
 * A page whose other images agree on one name offers that name, even for a single image left over;
 * otherwise a batch needs at least two images and offers the page title (or the site) as a draft.
 * `dismissed`: page keys the user said no to. Biggest batch first.
 */
export function suggestSourceProjects(
	items: Inspiration[],
	dismissed: ReadonlySet<string> = new Set()
): SourceProjectSuggestion[] {
	const pages = new Map<string, { url: string; host: string; loose: Inspiration[]; named: Inspiration[] }>();
	for (const i of items) {
		const host = hostOf(i.source_url);
		if (!host) continue;
		const key = pageKey(i.source_url!);
		const p = pages.get(key) ?? { url: i.source_url!, host, loose: [], named: [] };
		(cleanSourceProject(i.source_project) ? p.named : p.loose).push(i);
		pages.set(key, p);
	}
	const out: SourceProjectSuggestion[] = [];
	for (const [key, p] of pages) {
		if (!p.loose.length || dismissed.has(key)) continue;
		const known = tally(p.named);
		if (known.length === 1) {
			out.push({ key, url: p.url, ids: p.loose.map((i) => i.id), name: known[0].name, existing: true });
		} else if (p.loose.length >= 2) {
			const title = p.loose.map((i) => i.source_title?.trim()).find(Boolean);
			out.push({
				key,
				url: p.url,
				ids: p.loose.map((i) => i.id),
				name: cleanSourceProject(title) ?? p.host,
				existing: false
			});
		}
	}
	return out.sort((a, b) => b.ids.length - a.ids.length || Number(b.existing) - Number(a.existing));
}
