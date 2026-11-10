import type { PageLoad } from './$types';
import type { Project } from '#lib/types.js';
import { userTags } from '#lib/inspirations.js';

export const load: PageLoad = async ({ parent }) => {
	const { supabase } = await parent();
	const { data: projects } = await supabase
		.from('projects')
		.select('id, name, description, created_at')
		.order('name');
	const tags = await userTags(supabase).catch(() => []);
	return { projects: (projects ?? []) as Project[], tags };
};
