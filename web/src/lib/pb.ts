// The PocketBase client of the browser app. Auth lives in localStorage (the SDK's LocalAuthStore), so
// a signed-in user stays signed in across visits; the SDK refreshes the token on use.
import PocketBase from 'pocketbase';
import { acceptLanguage } from './i18n.js';
import { noteWrite } from './datacache.js';

export const PB_URL: string = import.meta.env.VITE_PB_URL || 'https://moodboard-api.haroldpoi.dev';

/** Make a client. Auto-cancellation is off: the app runs parallel requests to the same endpoint. */
export function createClient(url = PB_URL): PocketBase {
	const pb = new PocketBase(url);
	pb.autoCancellation(false);
	// The user each request was sent as: an answer that lands after an account switch belongs to the old one.
	const sentAs = new WeakMap<object, string | null>();
	// The server writes its error messages in the language the user picked.
	pb.beforeSend = (reqUrl, options) => {
		options.headers = { ...options.headers, 'Accept-Language': acceptLanguage() };
		sentAs.set(options, pb.authStore.record?.id ?? null);
		return { url: reqUrl, options };
	};
	// Keep the page data cache true after the app's own changes (src/lib/datacache.ts).
	pb.afterSend = (response: Response, data: unknown, options?: { method?: string }) => {
		const uid = options ? sentAs.get(options) : undefined;
		if (response.ok && uid !== undefined) noteWrite(response.url, options?.method ?? 'GET', uid);
		return data;
	};
	return pb;
}

export const pb = createClient();
