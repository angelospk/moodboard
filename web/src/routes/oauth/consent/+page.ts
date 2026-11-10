import { error, redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ url, parent }) => {
	const id = url.searchParams.get('authorization_id');
	if (!id) error(400, 'Λείπει το authorization_id');
	const { supabase } = await parent();
	const { data, error: e } = await supabase.auth.oauth.getAuthorizationDetails(id);
	if (e || !data) error(400, e?.message ?? 'Άκυρο αίτημα εξουσιοδότησης');
	// Already approved earlier: Supabase returns the final redirect directly.
	if (!('authorization_id' in data)) redirect(303, data.redirect_url);
	return { details: data };
};
