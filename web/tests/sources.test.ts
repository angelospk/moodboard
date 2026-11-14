// Grouping images by the website they came from (pure functions, no server).
import { describe, expect, it } from 'vitest';
import { filterItems, groupSources, hostOf } from '../src/lib/sources';
import type { Inspiration } from '../src/lib/types';

let n = 0;
function row(p: Partial<Inspiration>): Inspiration {
	n++;
	return {
		id: `i${n}`, project_id: null, image_path: `f${n}.png`, source_url: null, source_title: null, source_project: null, image_url: null,
		crop: null, note: '', tags: [], level: null, regions: [], created_at: `2026-11-0${(n % 9) + 1} 10:00:00.000Z`,
		updated_at: `2026-11-0${(n % 9) + 1} 10:00:00.000Z`, ...p
	};
}

describe('hostOf', () => {
	it('keeps the site name without www and ignores what is not a web page', () => {
		expect(hostOf('https://www.ArchDaily.com/123/house?x=1')).toBe('archdaily.com');
		expect(hostOf('http://pinterest.com/pin/1')).toBe('pinterest.com');
		expect(hostOf('chrome://extensions')).toBeNull();
		expect(hostOf('not a url')).toBeNull();
		expect(hostOf(null)).toBeNull();
	});
});

describe('groupSources', () => {
	it('groups by site, then by page, with project counts; most images first', () => {
		const items = [
			row({ source_url: 'https://www.archdaily.com/a', source_title: 'House A', project_id: 'p1' }),
			row({ source_url: 'https://archdaily.com/a', source_title: 'House A', project_id: 'p2' }),
			row({ source_url: 'https://archdaily.com/b', source_title: 'House B', project_id: 'p1' }),
			row({ source_url: 'https://pinterest.com/pin/1' }),
			row({ source_url: null })
		];
		const { sources, unsourced } = groupSources(items);
		expect(sources.map((s) => s.host)).toEqual(['archdaily.com', 'pinterest.com']);
		const ad = sources[0];
		expect(ad.items).toHaveLength(3);
		expect(ad.pages.map((p) => [p.title, p.items.length])).toEqual([['House A', 2], ['House B', 1]]);
		expect(ad.projects).toEqual([{ id: 'p1', count: 2 }, { id: 'p2', count: 1 }]);
		expect(sources[1].projects).toEqual([{ id: null, count: 1 }]);
		expect(unsourced).toHaveLength(1);
	});

	it('sorts by the newest image when asked', () => {
		const old = row({ source_url: 'https://a.com/1', created_at: '2026-01-01 00:00:00.000Z' });
		const old2 = row({ source_url: 'https://a.com/2', created_at: '2026-01-02 00:00:00.000Z' });
		const fresh = row({ source_url: 'https://b.com/1', created_at: '2026-11-10 00:00:00.000Z' });
		expect(groupSources([old, old2, fresh], 'recent').sources.map((s) => s.host)).toEqual(['b.com', 'a.com']);
		expect(groupSources([old, old2, fresh], 'count').sources.map((s) => s.host)).toEqual(['a.com', 'b.com']);
	});
});

describe('filterItems', () => {
	const items = [
		row({ source_url: 'https://archdaily.com/x', source_title: 'Villa Μάρμαρο', project_id: 'p1', tags: ['ξύλο'] }),
		row({ source_url: 'https://dezeen.com/y', note: 'ωραίο φως', project_id: 'p2', tags: ['φως'] }),
		row({ source_url: 'https://dezeen.com/z', project_id: null, regions: [{ x: 0, y: 0, w: 0.1, h: 0.1, note: 'λεπτομέρεια σκάλας' }] })
	];
	it('matches site, title, note, tags and region notes, without accents or case', () => {
		expect(filterItems(items, { query: 'DEZEEN' }).length).toBe(2);
		expect(filterItems(items, { query: 'μαρμαρο' }).map((i) => i.source_title)).toEqual(['Villa Μάρμαρο']);
		expect(filterItems(items, { query: 'σκαλας' })).toHaveLength(1);
		expect(filterItems(items, { query: 'φως' })).toHaveLength(1);
	});
	it('filters by project (null = no project) and tag', () => {
		expect(filterItems(items, { project: 'p1' })).toHaveLength(1);
		expect(filterItems(items, { project: null })).toHaveLength(1);
		expect(filterItems(items, { tag: 'φως' })).toHaveLength(1);
		expect(filterItems(items, {})).toHaveLength(3);
	});
});
