import type { PageLoad } from './$types';
import type { Project } from '#lib/types.js';

export const load: PageLoad = async ({ parent }) => {
	const { supabase } = await parent();
	const { data: projects } = await supabase
		.from('projects')
		.select('id, name, description, created_at')
		.order('name');
	return { projects: (projects ?? []) as Project[] };
};
