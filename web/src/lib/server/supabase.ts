import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_KEY, PUBLIC_SUPABASE_URL } from '$app/env/public';

/** Supabase client that acts as the owner of `accessToken`. Returns null when the token is invalid. */
export async function clientForToken(
	accessToken: string
): Promise<{ sb: SupabaseClient; userId: string } | null> {
	const sb = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_KEY, {
		global: { headers: { Authorization: `Bearer ${accessToken}` } },
		auth: { persistSession: false, autoRefreshToken: false }
	});
	const { data, error } = await sb.auth.getUser(accessToken);
	if (error || !data.user) return null;
	return { sb, userId: data.user.id };
}
