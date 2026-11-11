import PocketBase, { AsyncAuthStore } from 'pocketbase';

/** MV3 service workers and popups have no localStorage: keep the auth state in browser.storage.local. */
const AUTH_KEY = 'pb_auth';

const initial = browser.storage.local
	.get(AUTH_KEY)
	.then((result) => {
		const value = result[AUTH_KEY];
		return typeof value === 'string' ? value : '';
	})
	.catch(() => '');

const store = new AsyncAuthStore({
	save: async (serialized) => {
		await browser.storage.local.set({ [AUTH_KEY]: serialized });
	},
	clear: async () => {
		await browser.storage.local.remove(AUTH_KEY);
	},
	initial,
});

export const pb = new PocketBase(
	import.meta.env.WXT_PB_URL || 'https://pb.haroldpoi.dev',
	store,
);

// The popup and the web app can share overlapping requests; a new popup must not cancel the old one.
pb.autoCancellation(false);

/**
 * Wait until the stored auth state has been loaded into `pb.authStore`.
 * `AsyncAuthStore` registers its own continuation on the `initial` promise in
 * its constructor, before this one, so a resolved `initial` means the store is
 * already populated. The popup awaits this before it reads `pb.authStore.record`.
 */
export async function ready(): Promise<void> {
	await initial;
}

/** A user readable message from a PocketBase error (field errors first, then the response message). */
export function msg(error: unknown): string {
	const r = error as {
		response?: { message?: string; data?: Record<string, { message?: string }> };
		message?: string;
	};
	const field = r.response?.data && Object.entries(r.response.data)[0];
	if (field) return `${field[0]}: ${field[1]?.message ?? ''}`.trim();
	return r.response?.message || r.message || 'άγνωστο σφάλμα';
}
