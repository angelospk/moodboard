// «Προσθέτεις από»: the source every new image gets until the user stops it (or it lapses).
import { describe, expect, it } from 'vitest';
import type { Inspiration } from '../src/lib/types';
import {
	ACTIVE_SOURCE_TTL,
	liveSource,
	nameForPage,
	parseActiveSource,
	pastedPageUrl,
	sameSource,
	sourceFields
} from '../src/lib/activeSource';

const NOW = 1_800_000_000_000;

describe('parseActiveSource', () => {
	it('reads a stored source', () => {
		const raw = JSON.stringify({ url: 'https://a.com/p', project: 'Kolumba', at: NOW - 1000 });
		expect(parseActiveSource(raw)).toEqual({ url: 'https://a.com/p', project: 'Kolumba', at: NOW - 1000 });
	});
	it('nothing stored, broken JSON or a bad shape: none', () => {
		expect(parseActiveSource(null)).toBeNull();
		expect(parseActiveSource('{')).toBeNull();
		expect(parseActiveSource(JSON.stringify({ url: 'javascript:alert(1)', project: null, at: NOW }))).toBeNull();
		expect(parseActiveSource(JSON.stringify({ url: 'https://a.com', project: 3, at: NOW }))).toBeNull();
		expect(parseActiveSource(JSON.stringify({ url: 'https://a.com', project: null }))).toBeNull();
	});
	it('a stored name is cleaned; an empty one means no name', () => {
		const raw = JSON.stringify({ url: 'https://a.com/p', project: '  Villa   Savoye ', at: NOW });
		expect(parseActiveSource(raw)?.project).toBe('Villa Savoye');
		expect(parseActiveSource(JSON.stringify({ url: 'https://a.com/p', project: ' ', at: NOW }))?.project).toBeNull();
	});
});

describe('liveSource', () => {
	const src = { url: 'https://a.com/p', project: null, at: NOW };
	it('stays live for an hour after its last use, then lapses', () => {
		expect(liveSource(src, NOW + ACTIVE_SOURCE_TTL - 1)).toBe(src);
		expect(liveSource(src, NOW + ACTIVE_SOURCE_TTL)).toBeNull();
		expect(liveSource(null, NOW)).toBeNull();
	});
});

describe('pastedPageUrl', () => {
	it('one http(s) address, alone: that page', () => {
		expect(pastedPageUrl('  https://www.archdaily.com/1/kolumba \n')).toBe('https://www.archdaily.com/1/kolumba');
		expect(pastedPageUrl('http://site.gr/x?y=1')).toBe('http://site.gr/x?y=1');
	});
	it('words, several addresses, other schemes or bare hosts: not a page', () => {
		expect(pastedPageUrl('wood light')).toBeNull();
		expect(pastedPageUrl('see https://a.com/x')).toBeNull();
		expect(pastedPageUrl('https://a.com/x https://b.com/y')).toBeNull();
		expect(pastedPageUrl('javascript:alert(1)')).toBeNull();
		expect(pastedPageUrl('archdaily.com')).toBeNull();
		expect(pastedPageUrl('https://localhost/x')).toBeNull();
		expect(pastedPageUrl('')).toBeNull();
	});
});

describe('nameForPage', () => {
	const row = (source_url: string | null, source_project: string | null) =>
		({ id: Math.random().toString(36), source_url, source_project }) as Inspiration;
	it('the name the images of that page already have, most used first', () => {
		const items = [
			row('https://www.a.com/p/', 'Kolumba'),
			row('https://a.com/p#x', 'Kolumba'),
			row('https://a.com/p', 'Other'),
			row('https://a.com/q', 'Q')
		];
		expect(nameForPage(items, 'https://a.com/p')).toBe('Kolumba');
	});
	it('no image of that page has a name: none', () => {
		expect(nameForPage([row('https://a.com/p', null), row('https://b.com/p', 'B')], 'https://a.com/p')).toBeNull();
	});
});

describe('sourceFields', () => {
	it('the fields a new image gets; none without a live source', () => {
		expect(sourceFields({ url: 'https://a.com/p', project: 'K', at: NOW })).toEqual({
			source_url: 'https://a.com/p',
			source_project: 'K'
		});
		expect(sourceFields(null)).toEqual({});
	});
});

describe('sameSource', () => {
	const a = { url: 'https://a.com/p', project: 'K', at: NOW };
	it('same page and name, whatever the time', () => {
		expect(sameSource(a, { ...a, at: NOW + 5 })).toBe(true);
	});
	it('another page, another name, or none: not the same', () => {
		expect(sameSource(a, { ...a, url: 'https://a.com/q' })).toBe(false);
		expect(sameSource(a, { ...a, project: null })).toBe(false);
		expect(sameSource(a, null)).toBe(false);
		expect(sameSource(null, null)).toBe(false);
	});
});
