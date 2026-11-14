import type { PageLoad } from './$types.js';
import { listProjects, listSourceProjectNames, userTags } from '#lib/inspirations.js';

export const load: PageLoad = async ({ parent }) => {
	const { pb } = await parent();
	const projects = (await listProjects(pb)).filter((p) => !p.archived);
	const [tags, sourceProjects] = await Promise.all([
		userTags(pb).catch(() => []),
		listSourceProjectNames(pb).catch(() => [])
	]);
	return { projects, tags, sourceProjects };
};
