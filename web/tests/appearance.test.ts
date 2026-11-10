import { describe, expect, it } from 'vitest';
import { CANVASES, DEFAULT_PREFS, parsePrefs, canvasColor } from '../src/lib/appearance';

describe('appearance prefs', () => {
	it('falls back to defaults on missing or broken storage', () => {
		expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
		expect(parsePrefs('{nope')).toEqual(DEFAULT_PREFS);
		expect(parsePrefs('42')).toEqual(DEFAULT_PREFS);
	});

	it('keeps valid values and drops unknown ones per field', () => {
		const p = parsePrefs(JSON.stringify({ theme: 'dark', light: 'white', dark: 'nope' }));
		expect(p).toEqual({ theme: 'dark', light: 'white', dark: DEFAULT_PREFS.dark });
		expect(parsePrefs(JSON.stringify({ theme: 'pink' })).theme).toBe('auto');
	});

	it('a light canvas is never offered in dark mode and the reverse', () => {
		for (const c of CANVASES.light) expect(CANVASES.dark.map((d) => d.id)).not.toContain(c.id);
		expect(parsePrefs(JSON.stringify({ light: CANVASES.dark[1].id })).light).toBe(DEFAULT_PREFS.light);
	});

	it('canvasColor returns the hex of the chosen swatch', () => {
		expect(canvasColor('light', 'white')).toBe('#ffffff');
		expect(canvasColor('dark', 'unknown')).toBe(CANVASES.dark[0].color);
	});
});
