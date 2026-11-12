// The PocketBase client of the browser app. Auth lives in localStorage (the SDK's LocalAuthStore), so
// a signed-in user stays signed in across visits; the SDK refreshes the token on use.
import PocketBase from 'pocketbase';
import { acceptLanguage } from './i18n.js';

export const PB_URL: string = import.meta.env.VITE_PB_URL || 'https://moodboard-api.haroldpoi.dev';

/** Make a client. Auto-cancellation is off: the app runs parallel requests to the same endpoint. */
export function createClient(url = PB_URL): PocketBase {
	const pb = new PocketBase(url);
	pb.autoCancellation(false);
	// The server writes its error messages in the language the user picked.
	pb.beforeSend = (reqUrl, options) => {
		options.headers = { ...options.headers, 'Accept-Language': acceptLanguage() };
		return { url: reqUrl, options };
	};
	return pb;
}

export const pb = createClient();
