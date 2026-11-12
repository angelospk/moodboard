// UI language of the extension. Same idea as web/src/lib/i18n.ts: Greek is the source catalog, English
// must have the same keys, and changing the language reloads the popup. The choice is stored in
// browser.storage.local, which the popup and the background script both read.
import { el } from './messages/el';
import { en } from './messages/en';

export const LOCALES = ['el', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_NAMES: Record<Locale, string> = { el: 'Ελληνικά', en: 'English' };

export type Key = keyof typeof el;
export type Params = Record<string, string | number>;

const catalogs: Record<Locale, Record<Key, string>> = { el, en };
const STORAGE_KEY = 'moodboard_lang';

export function pickLocale(stored: string | null | undefined, languages: readonly string[] = []): Locale {
	for (const c of [stored, ...languages]) {
		const base = c?.toLowerCase().split('-')[0];
		if (base && (LOCALES as readonly string[]).includes(base)) return base as Locale;
	}
	return 'el';
}

export function fmt(text: string, params?: Params): string {
	return params ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : text;
}

let current: Locale = 'el';

/** Read the stored or browser language. Await it before the first render or the first menu. */
export async function initLocale(): Promise<Locale> {
	let stored: string | null = null;
	try {
		const r = await browser.storage.local.get(STORAGE_KEY);
		stored = typeof r[STORAGE_KEY] === 'string' ? (r[STORAGE_KEY] as string) : null;
	} catch {
		/* no storage: use the browser language */
	}
	current = pickLocale(stored, [...(globalThis.navigator?.languages ?? []), browser.i18n.getUILanguage()]);
	if (typeof document !== 'undefined') document.documentElement.lang = current;
	return current;
}

export const getLocale = (): Locale => current;

/** Save the language. The popup reloads to redraw its text; the background script listens to storage. */
export async function setLocale(locale: Locale): Promise<void> {
	await browser.storage.local.set({ [STORAGE_KEY]: locale });
	current = locale;
	if (typeof document !== 'undefined') location.reload();
}

/** Call fn when the language changes in another part of the extension (the popup). */
export function onLocaleChange(fn: () => void): void {
	browser.storage.onChanged.addListener((changes, area) => {
		if (area === 'local' && STORAGE_KEY in changes) void initLocale().then(fn);
	});
}

export const t = (key: Key, params?: Params): string => fmt(catalogs[current][key], params);
export const acceptLanguage = (): string => current;
