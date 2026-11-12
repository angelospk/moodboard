// UI language: the t() helpers and the message catalogs.
import { describe, expect, it } from 'vitest';
import { LOCALES, fmt, pickLocale, plural, translate } from '../src/lib/i18n';
import { el } from '../src/lib/messages/el';
import { en } from '../src/lib/messages/en';
import { el as xel } from '../../extension/src/lib/messages/el';
import { en as xen } from '../../extension/src/lib/messages/en';

describe('pickLocale', () => {
	it('prefers a supported stored choice', () => {
		expect(pickLocale('en', ['el-GR'])).toBe('en');
		expect(pickLocale('el', ['en-US'])).toBe('el');
	});
	it('ignores an unknown stored choice and uses the first supported browser language', () => {
		expect(pickLocale('xx', ['fr-FR', 'en-GB'])).toBe('en');
		expect(pickLocale(null, ['en-US'])).toBe('en');
	});
	it('falls back to Greek', () => {
		expect(pickLocale(null, [])).toBe('el');
		expect(pickLocale(undefined, ['de-DE'])).toBe('el');
	});
});

describe('fmt', () => {
	it('fills {name} placeholders and leaves unknown ones', () => {
		expect(fmt('Hi {name}, {n} left, {x}', { name: 'Ann', n: 3 })).toBe('Hi Ann, 3 left, {x}');
	});
	it('does not treat a value as a pattern', () => {
		expect(fmt('{a}', { a: '$& {b}' })).toBe('$& {b}');
	});
});

describe('translate and plural', () => {
	it('returns the text of the locale', () => {
		expect(translate('en', 'common.cancel')).toBe(en['common.cancel']);
		expect(translate('el', 'common.cancel')).toBe(el['common.cancel']);
	});
	it('picks one/other by the language rules', () => {
		expect(plural('en', 'common.images', 1)).toBe('1 image');
		expect(plural('en', 'common.images', 3)).toBe('3 images');
		expect(plural('el', 'common.images', 1)).toBe('1 εικόνα');
		expect(plural('el', 'common.images', 0)).toBe('0 εικόνες');
	});
});

describe('catalogs', () => {
	const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
	it('English has exactly the Greek keys', () => {
		expect(Object.keys(en).sort()).toEqual(Object.keys(el).sort());
	});
	it('both languages use the same placeholders in every message', () => {
		for (const k of Object.keys(el) as (keyof typeof el)[]) {
			expect(params(en[k]), k).toBe(params(el[k]));
		}
	});
	it('no message is empty', () => {
		for (const l of LOCALES) {
			const d = l === 'el' ? el : en;
			for (const [k, v] of Object.entries(d)) expect(v.trim(), `${l}:${k}`).not.toBe('');
		}
	});
	it('every plural key has both forms', () => {
		for (const d of [el, en]) {
			for (const k of Object.keys(d)) {
				if (k.endsWith('_one')) expect(d, k).toHaveProperty(k.replace(/_one$/, '_other'));
				if (k.endsWith('_other')) expect(d, k).toHaveProperty(k.replace(/_other$/, '_one'));
			}
		}
	});
});

describe('extension catalogs', () => {
	const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
	it('English has exactly the Greek keys and placeholders', () => {
		expect(Object.keys(xen).sort()).toEqual(Object.keys(xel).sort());
		for (const k of Object.keys(xel) as (keyof typeof xel)[]) expect(params(xen[k]), k).toBe(params(xel[k]));
	});
});
