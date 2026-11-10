import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	PUBLIC_SUPABASE_URL: { public: true, description: 'Supabase API URL' },
	PUBLIC_SUPABASE_KEY: { public: true, description: 'Supabase publishable (anon) key' },
	APP_URL: { description: 'Public origin of this app, e.g. https://host:10460 (OAuth resource metadata)' }
});
