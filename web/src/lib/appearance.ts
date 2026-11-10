/**
 * Viewer appearance: theme (auto / light / dark) and canvas colour per theme.
 * Stored in localStorage (a per-viewer convenience); src/app.html applies it before first paint.
 */
export type Theme = 'auto' | 'light' | 'dark';
export type Prefs = { theme: Theme; light: string; dark: string };
export type Canvas = { id: string; name: string; color: string };

/** Light canvases suit dark text, dark canvases light text; each theme offers only its own. */
export const CANVASES: Record<'light' | 'dark', Canvas[]> = {
	light: [
		{ id: 'paper', name: 'Χαρτί', color: '#f4f1eb' },
		{ id: 'white', name: 'Λευκό', color: '#ffffff' },
		{ id: 'concrete', name: 'Μπετό', color: '#e6e4df' },
		{ id: 'sand', name: 'Άμμος', color: '#efe6d6' }
	],
	dark: [
		{ id: 'night', name: 'Νύχτα', color: '#161513' },
		{ id: 'graphite', name: 'Γραφίτης', color: '#24262a' },
		{ id: 'black', name: 'Μαύρο', color: '#0a0a0a' },
		{ id: 'walnut', name: 'Καρυδιά', color: '#1f1915' }
	]
};

export const THEMES: { id: Theme; name: string }[] = [
	{ id: 'auto', name: 'Αυτόματο' },
	{ id: 'light', name: 'Ανοιχτό' },
	{ id: 'dark', name: 'Σκούρο' }
];

export const DEFAULT_PREFS: Prefs = { theme: 'auto', light: 'paper', dark: 'night' };
export const STORAGE_KEY = 'moodboard.appearance';

const has = (mode: 'light' | 'dark', id: unknown) => CANVASES[mode].some((c) => c.id === id);

export function parsePrefs(raw: string | null): Prefs {
	let v: unknown;
	try {
		v = raw ? JSON.parse(raw) : null;
	} catch {
		v = null;
	}
	const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
	return {
		theme: THEMES.some((t) => t.id === o.theme) ? (o.theme as Theme) : DEFAULT_PREFS.theme,
		light: has('light', o.light) ? (o.light as string) : DEFAULT_PREFS.light,
		dark: has('dark', o.dark) ? (o.dark as string) : DEFAULT_PREFS.dark
	};
}

export function canvasColor(mode: 'light' | 'dark', id: string): string {
	return (CANVASES[mode].find((c) => c.id === id) ?? CANVASES[mode][0]).color;
}

export function loadPrefs(): Prefs {
	try {
		return parsePrefs(localStorage.getItem(STORAGE_KEY));
	} catch {
		return { ...DEFAULT_PREFS };
	}
}

/** Write the prefs to <html> (data-theme + canvas colours) and storage. */
export function applyPrefs(p: Prefs, save = true) {
	const root = document.documentElement;
	if (p.theme === 'auto') delete root.dataset.theme;
	else root.dataset.theme = p.theme;
	const lc = canvasColor('light', p.light);
	const dc = canvasColor('dark', p.dark);
	root.style.setProperty('--canvas-light', lc);
	root.style.setProperty('--canvas-dark', dc);
	if (!save) return;
	try {
		// lc/dc let the boot script in src/app.html paint the right canvas before the app loads.
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...p, lc, dc }));
	} catch {
		/* private mode: the choice lasts for this page only */
	}
}
