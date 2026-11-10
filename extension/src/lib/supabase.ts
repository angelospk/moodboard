import { createClient, type SupportedStorage } from '@supabase/supabase-js';

/** MV3 service workers and popups have no localStorage: keep the session in chrome.storage.local. */
const chromeStorage: SupportedStorage = {
	async getItem(key: string) {
		const result = await browser.storage.local.get(key);
		const value = result[key];
		return typeof value === 'string' ? value : null;
	},
	async setItem(key: string, value: string) {
		await browser.storage.local.set({ [key]: value });
	},
	async removeItem(key: string) {
		await browser.storage.local.remove(key);
	},
};

export const supabase = createClient(
	import.meta.env.WXT_SUPABASE_URL,
	import.meta.env.WXT_SUPABASE_KEY,
	{
		auth: {
			storage: chromeStorage,
			persistSession: true,
			autoRefreshToken: true,
			detectSessionInUrl: false,
		},
	},
);
