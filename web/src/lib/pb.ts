// The PocketBase client of the browser app. Auth lives in localStorage (the SDK's LocalAuthStore), so
// a signed-in user stays signed in across visits; the SDK refreshes the token on use.
import PocketBase from 'pocketbase';

export const PB_URL: string = import.meta.env.VITE_PB_URL || 'https://pb.haroldpoi.dev';

/** Make a client. Auto-cancellation is off: the app runs parallel requests to the same endpoint. */
export function createClient(url = PB_URL): PocketBase {
	const pb = new PocketBase(url);
	pb.autoCancellation(false);
	return pb;
}

export const pb = createClient();
