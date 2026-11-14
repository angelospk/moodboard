// Sections of the image list: by first tag (like the map zones), or by source project.
import { describe, expect, it } from 'vitest';
import type { Inspiration } from '../src/lib/types';
import { groupByFirstTag, parseGroupMode } from '../src/lib/sections';

let n = 0;
function img(tags: string[]): Inspiration {
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
		tags,
		level: null,
		regions: [],
		suggestion: null,
		colors: [],
		created_at: '2026-01-01 00:00:00.000Z',
		updated_at: '2026-01-01 00:00:00.000Z'
	} as Inspiration;
}

const shape = (secs: { key: string; name: string; items: Inspiration[] }[]) =>
	secs.map((s) => [s.key, s.name, s.items.map((i) => i.id)]);

describe('groupByFirstTag', () => {
	it('one section per first tag, biggest first, then alphabetical; untagged last', () => {
		const a = img(['wood', 'light']);
		const b = img(['concrete']);
		const c = img(['wood']);
		const d = img([]);
		const e = img(['brick']);
		expect(shape(groupByFirstTag([a, b, c, d, e], { noneName: 'No tag' }))).toEqual([
			['wood', 'wood', [a.id, c.id]],
			['brick', 'brick', [e.id]],
			['concrete', 'concrete', [b.id]],
			['', 'No tag', [d.id]]
		]);
	});
	it('only the first tag counts; a blank first tag counts as no tag', () => {
		const a = img(['light', 'wood']);
		const b = img(['  ']);
		expect(shape(groupByFirstTag([a, b], { noneName: '-' }))).toEqual([
			['light', 'light', [a.id]],
			['', '-', [b.id]]
		]);
	});
	it('ranked: sections follow their best result and keep its order', () => {
		const a = img(['x']);
		const b = img(['y']);
		const c = img(['y']);
		const d = img(['x']);
		expect(shape(groupByFirstTag([a, b, c, d], { noneName: '-', ranked: true }))).toEqual([
			['x', 'x', [a.id, d.id]],
			['y', 'y', [b.id, c.id]]
		]);
	});
	it('no images: no sections', () => {
		expect(groupByFirstTag([], { noneName: '-' })).toEqual([]);
	});
});

describe('parseGroupMode', () => {
	it('reads the stored mode; the old "1" meant by source project', () => {
		expect(parseGroupMode('tag')).toBe('tag');
		expect(parseGroupMode('source')).toBe('source');
		expect(parseGroupMode('1')).toBe('source');
		expect(parseGroupMode('0')).toBe('');
		expect(parseGroupMode(null)).toBe('');
		expect(parseGroupMode('junk')).toBe('');
	});
});
