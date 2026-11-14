// The «source project» of an image: the work it was taken from (a case study, a portfolio piece).
import { describe, expect, it } from 'vitest';
import type { Inspiration } from '../src/lib/types';
import {
	cleanSourceProject,
	groupBySourceProject,
	sourceProjectNames,
	suggestSourceProjects,
	undoBatches,
	undoStillValid
} from '../src/lib/sourceProjects';

let n = 0;
function img(over: Partial<Inspiration> = {}): Inspiration {
	n++;
	return {
		id: `i${n}`,
		project_id: null,
		image_path: `f${n}.png`,
		source_url: null,
		source_title: null,
		source_project: null,
		image_url: null,
		crop: null,
		note: '',
		tags: [],
		level: null,
		regions: [],
		suggestion: null,
		colors: [],
		created_at: '2026-01-01 00:00:00.000Z',
		updated_at: '2026-01-01 00:00:00.000Z',
		...over
	};
}

describe('cleanSourceProject', () => {
	it('trims and collapses inner spaces', () => {
		expect(cleanSourceProject('  Villa   Savoye \n')).toBe('Villa Savoye');
	});
	it('empty or blank text means no source project', () => {
		expect(cleanSourceProject('   ')).toBeNull();
		expect(cleanSourceProject('')).toBeNull();
		expect(cleanSourceProject(null)).toBeNull();
		expect(cleanSourceProject(undefined)).toBeNull();
	});
	it('cuts at 200 characters', () => {
		expect(cleanSourceProject('x'.repeat(300))).toHaveLength(200);
	});
});

describe('sourceProjectNames', () => {
	it('lists distinct names, most used first, then alphabetical', () => {
		const items = [
			img({ source_project: 'Bravo' }),
			img({ source_project: 'Alpha' }),
			img({ source_project: 'Bravo' }),
			img({ source_project: 'Charlie' }),
			img()
		];
		expect(sourceProjectNames(items)).toEqual(['Bravo', 'Alpha', 'Charlie']);
	});
	it('merges spellings that differ only in case, accents or spaces; keeps the most used spelling', () => {
		const items = [
			img({ source_project: 'Μάρμαρο' }),
			img({ source_project: 'μαρμαρο' }),
			img({ source_project: 'μαρμαρο' }),
			img({ source_project: ' μαρμαρο ' })
		];
		expect(sourceProjectNames(items)).toEqual(['μαρμαρο']);
	});
});

describe('groupBySourceProject', () => {
	const NONE = 'No source';
	it('makes one section per name, biggest first, images without one last', () => {
		const a1 = img({ source_project: 'Alpha' });
		const b1 = img({ source_project: 'Bravo' });
		const b2 = img({ source_project: 'Bravo' });
		const none = img();
		const out = groupBySourceProject([a1, none, b1, b2], { noneName: NONE });
		expect(out.map((s) => s.name)).toEqual(['Bravo', 'Alpha', NONE]);
		expect(out.map((s) => s.items.map((i) => i.id))).toEqual([[b1.id, b2.id], [a1.id], [none.id]]);
		expect(out[2].key).toBe('');
	});
	it('same count: alphabetical', () => {
		const out = groupBySourceProject([img({ source_project: 'Zeta' }), img({ source_project: 'Alpha' })], { noneName: NONE });
		expect(out.map((s) => s.name)).toEqual(['Alpha', 'Zeta']);
	});
	it('has no last section when every image has a name', () => {
		const out = groupBySourceProject([img({ source_project: 'A' })], { noneName: NONE });
		expect(out.map((s) => s.name)).toEqual(['A']);
	});
	it('keeps one section for spellings that differ in case', () => {
		const out = groupBySourceProject(
			[img({ source_project: 'Villa Savoye' }), img({ source_project: 'villa savoye' })],
			{ noneName: NONE }
		);
		expect(out).toHaveLength(1);
		expect(out[0].items).toHaveLength(2);
	});
	it('ranked: sections follow their best result and keep the search order; none stays last', () => {
		const a = img({ source_project: 'Alpha' });
		const b = img({ source_project: 'Bravo' });
		const c = img({ source_project: 'Alpha' });
		const none = img();
		// Search order: none, b, a, c. Bravo's best is 2nd, Alpha's best is 3rd.
		const out = groupBySourceProject([none, b, a, c], { noneName: NONE, ranked: true });
		expect(out.map((s) => s.name)).toEqual(['Bravo', 'Alpha', NONE]);
		expect(out[1].items.map((i) => i.id)).toEqual([a.id, c.id]);
	});
	it('no images: no sections', () => {
		expect(groupBySourceProject([], { noneName: NONE })).toEqual([]);
	});
});

describe('suggestSourceProjects', () => {
	const page = 'https://archdaily.com/123/villa-savoye';
	it('offers images without a name that share a page, with the page title as the draft name', () => {
		const items = [
			img({ source_url: page, source_title: 'Villa Savoye / Le Corbusier' }),
			img({ source_url: `${page}#gallery`, source_title: null }),
			img({ source_url: 'https://archdaily.com/999/other' })
		];
		const out = suggestSourceProjects(items);
		expect(out).toHaveLength(1);
		expect(out[0].ids).toEqual([items[0].id, items[1].id]);
		expect(out[0].name).toBe('Villa Savoye / Le Corbusier');
		expect(out[0].existing).toBe(false);
		expect(out[0].url).toBe(page);
	});
	it('the page title starts with a name already in use: offer that name, not a second spelling', () => {
		const items = [
			img({ source_url: 'https://pinterest.com/pin/1', source_project: 'Villa Savoye' }),
			img({ source_url: page, source_title: 'villa savoye / Le Corbusier' }),
			img({ source_url: page })
		];
		const out = suggestSourceProjects(items);
		expect(out).toHaveLength(1);
		expect(out[0].name).toBe('Villa Savoye');
		expect(out[0].existing).toBe(false);
	});
	it('only a whole-word start of the title counts, and short names never match', () => {
		const items = [
			img({ source_url: 'https://a.com/1', source_project: 'Villa' }),
			img({ source_url: 'https://a.com/2', source_project: 'Casa' }),
			img({ source_url: 'https://a.com/3', source_project: 'Ab' }),
			img({ source_url: page, source_title: 'Villanova House' }),
			img({ source_url: page }),
			img({ source_url: 'https://b.com/x', source_title: 'Ab Studio' }),
			img({ source_url: 'https://b.com/x' })
		];
		expect(suggestSourceProjects(items).map((s) => s.name).sort()).toEqual(['Ab Studio', 'Villanova House']);
	});
	it('several names match: the longest one', () => {
		const items = [
			img({ source_url: 'https://a.com/1', source_project: 'Villa Savoye' }),
			img({ source_url: 'https://a.com/2', source_project: 'Villa Savoye Poissy' }),
			img({ source_url: page, source_title: 'Villa Savoye Poissy, 1931' }),
			img({ source_url: page })
		];
		expect(suggestSourceProjects(items)[0].name).toBe('Villa Savoye Poissy');
	});
	it('treats www, a trailing slash and a #fragment as the same page', () => {
		const items = [
			img({ source_url: 'https://www.site.com/p/1/' }),
			img({ source_url: 'https://site.com/p/1#x' })
		];
		expect(suggestSourceProjects(items)).toHaveLength(1);
	});
	it('does not offer a single image alone', () => {
		expect(suggestSourceProjects([img({ source_url: page })])).toEqual([]);
	});
	it('ignores images that have no page, or a page that is not http(s)', () => {
		const items = [img(), img(), img({ source_url: 'javascript:alert(1)' }), img({ source_url: 'javascript:alert(1)' })];
		expect(suggestSourceProjects(items)).toEqual([]);
	});
	it('ignores images that already have a name', () => {
		const items = [
			img({ source_url: page, source_project: 'Villa' }),
			img({ source_url: page, source_project: 'Villa' })
		];
		expect(suggestSourceProjects(items)).toEqual([]);
	});
	it('one image on a page where others already have a name: offer that name', () => {
		const named = img({ source_url: page, source_project: 'Villa Savoye' });
		const loose = img({ source_url: page });
		const out = suggestSourceProjects([named, loose]);
		expect(out).toHaveLength(1);
		expect(out[0].ids).toEqual([loose.id]);
		expect(out[0].name).toBe('Villa Savoye');
		expect(out[0].existing).toBe(true);
	});
	it('a page whose named images disagree: falls back to the page title, not an existing name', () => {
		const items = [
			img({ source_url: page, source_project: 'A' }),
			img({ source_url: page, source_project: 'B' }),
			img({ source_url: page, source_title: 'T' }),
			img({ source_url: page })
		];
		const out = suggestSourceProjects(items);
		expect(out).toHaveLength(1);
		expect(out[0].existing).toBe(false);
		expect(out[0].name).toBe('T');
	});
	it('no title: the draft name is the host', () => {
		const out = suggestSourceProjects([img({ source_url: 'https://www.site.com/a' }), img({ source_url: 'https://site.com/a' })]);
		expect(out[0].name).toBe('site.com');
	});
	it('lists the biggest batch first, existing-name offers before new names on a tie', () => {
		const big = [img({ source_url: 'https://a.com/1' }), img({ source_url: 'https://a.com/1' }), img({ source_url: 'https://a.com/1' })];
		const small = [img({ source_url: 'https://b.com/1' }), img({ source_url: 'https://b.com/1' })];
		const out = suggestSourceProjects([...small, ...big]);
		expect(out.map((s) => s.ids.length)).toEqual([3, 2]);
	});
	it('a page in the dismissed list is left out', () => {
		const items = [img({ source_url: page }), img({ source_url: page })];
		const [first] = suggestSourceProjects(items);
		expect(suggestSourceProjects(items, new Set([first.key]))).toEqual([]);
	});
});

describe('undoBatches', () => {
	it('puts each changed image back to the name it had: one batch per previous name', () => {
		const before = new Map<string, string | null>([
			['a', 'Therme Vals'],
			['b', null],
			['c', 'Therme Vals'],
			['d', 'Kolumba']
		]);
		expect(undoBatches(before, ['a', 'b', 'c', 'd'])).toEqual([
			{ name: 'Therme Vals', ids: ['a', 'c'] },
			{ name: null, ids: ['b'] },
			{ name: 'Kolumba', ids: ['d'] }
		]);
	});
	it('only the images that really changed: failed ones and unknown ids are left alone', () => {
		const before = new Map<string, string | null>([
			['a', null],
			['b', 'X']
		]);
		expect(undoBatches(before, ['b', 'zzz'])).toEqual([{ name: 'X', ids: ['b'] }]);
		expect(undoBatches(before, [])).toEqual([]);
	});
	it('a blank previous value counts as no name', () => {
		const before = new Map<string, string | null>([
			['a', '  '],
			['b', null]
		]);
		expect(undoBatches(before, ['a', 'b'])).toEqual([{ name: null, ids: ['a', 'b'] }]);
	});
});

describe('undoStillValid', () => {
	const batches = [
		{ name: 'Therme Vals', ids: ['a', 'b'] },
		{ name: null, ids: ['c'] }
	];
	it('keeps only images that still have the name the change set (none changed them since)', () => {
		const now = new Map<string, string | null>([
			['a', 'Kolumba'],
			['b', 'Other'],
			['c', ' kolumba ']
		]);
		expect(undoStillValid(batches, 'Kolumba', now)).toEqual([
			{ name: 'Therme Vals', ids: ['a'] },
			{ name: null, ids: ['c'] }
		]);
	});
	it('a clear (null) is undone only where the image still has no name; gone images are dropped', () => {
		const now = new Map<string, string | null>([
			['a', null],
			['c', 'New']
		]);
		expect(undoStillValid(batches, null, now)).toEqual([{ name: 'Therme Vals', ids: ['a'] }]);
	});
});
