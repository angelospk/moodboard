// UI language. Greek (messages/el.ts) is the source catalog; English (messages/en.ts) must have the
// same keys, which the type checker enforces. No library: the app needs plain text, {name}
// placeholders and one/other plurals, and the browser's Intl does the rest.
//
// The language is read once at start. Changing it saves the choice and reloads the page, so no
// text has to track the language while it is on screen.
import { el } from './messages/el.js';
import { en } from './messages/en.js';

export const LOCALES = ['el', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_NAMES: Record<Locale, string> = { el: 'Ελληνικά', en: 'English' };
/** BCP 47 tag for Intl and the <html lang> attribute. */
export const LOCALE_TAGS: Record<Locale, string> = { el: 'el-GR', en: 'en-GB' };

export type Key = keyof typeof el;
type PluralKey<K> = K extends `${infer B}_other` ? B : never;
/** The base name of a message that has _one and _other forms. */
export type PluralBase = PluralKey<Key>;
export type Params = Record<string, string | number>;

const catalogs: Record<Locale, Record<Key, string>> = { el, en };
const STORAGE_KEY = 'moodboard:lang';

/** The first supported language of: the stored choice, then the browser's languages. Else Greek. */
export function pickLocale(stored: string | null | undefined, languages: readonly string[] = []): Locale {
	for (const c of [stored, ...languages]) {
		const base = c?.toLowerCase().split('-')[0];
		if (base && (LOCALES as readonly string[]).includes(base)) return base as Locale;
	}
	return 'el';
}

/** Fill {name} placeholders; an unknown one stays as written. */
export function fmt(text: string, params?: Params): string {
	return params ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : text;
}

export function translate(locale: Locale, key: Key, params?: Params): string {
	return fmt(catalogs[locale][key], params);
}

/** The _one or _other form of a message for the count n; {n} is filled in. */
export function plural(locale: Locale, base: PluralBase, n: number, params?: Params): string {
	const form = new Intl.PluralRules(LOCALE_TAGS[locale]).select(n) === 'one' ? 'one' : 'other';
	return translate(locale, `${base}_${form}` as Key, { n, ...params });
}

let current: Locale = 'el';

/** Read the saved or browser language. Call once before the first render (a no-op outside a browser). */
export function initLocale(): Locale {
	try {
		current = pickLocale(globalThis.localStorage?.getItem(STORAGE_KEY), globalThis.navigator?.languages ?? []);
	} catch {
		current = pickLocale(null, globalThis.navigator?.languages ?? []);
	}
	if (typeof document !== 'undefined') document.documentElement.lang = LOCALE_TAGS[current];
	return current;
}

// Read the language as soon as this module loads in a browser: some modules build text at load time.
if (typeof window !== 'undefined') initLocale();

export const getLocale = (): Locale => current;

/** Save the language and reload, so every text is drawn again in it. */
export function setLocale(locale: Locale): void {
	try {
		globalThis.localStorage?.setItem(STORAGE_KEY, locale);
	} catch {
		/* private mode: the choice lasts until the reload only */
	}
	current = locale;
	if (typeof location !== 'undefined') location.reload();
}

export const t = (key: Key, params?: Params): string => translate(current, key, params);
export const tn = (base: PluralBase, n: number, params?: Params): string => plural(current, base, n, params);

/** The language for a request header: the server writes its messages in it. */
export const acceptLanguage = (): string => current;

/** "3 minutes ago" in the current language. */
export function timeAgo(from: Date, now: Date = new Date()): string {
	const rtf = new Intl.RelativeTimeFormat(LOCALE_TAGS[current], { numeric: 'auto' });
	const seconds = Math.round((from.getTime() - now.getTime()) / 1000);
	const units: [Intl.RelativeTimeFormatUnit, number][] = [
		['year', 31536000],
		['month', 2592000],
		['week', 604800],
		['day', 86400],
		['hour', 3600],
		['minute', 60]
	];
	for (const [unit, size] of units) {
		if (Math.abs(seconds) >= size) return rtf.format(Math.trunc(seconds / size), unit);
	}
	return rtf.format(0, 'second');
}
