import type { PageLoad } from './$types.js';
import { listProjects, userTags } from '#lib/inspirations.js';

export const load: PageLoad = async ({ parent }) => {
	const { pb } = await parent();
	const projects = await listProjects(pb);
	const tags = await userTags(pb).catch(() => []);
	return { projects, tags };
};
