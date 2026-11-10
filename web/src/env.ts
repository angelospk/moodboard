import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	PUBLIC_SUPABASE_URL: { public: true, description: 'Supabase API URL' },
	PUBLIC_SUPABASE_KEY: { public: true, description: 'Supabase publishable (anon) key' }
});
