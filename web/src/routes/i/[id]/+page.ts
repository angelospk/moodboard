import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types.js';
import { getInspiration, imageUrls, listProjects, listSourceProjectNames, userTags } from '#lib/inspirations.js';
import { t } from '#lib/i18n.js';

export const load: PageLoad = async ({ params, parent, depends }) => {
	depends('moodboard:data');
	const { pb } = await parent();

	const [row, projects, tags, sourceProjects] = await Promise.all([
		getInspiration(pb, params.id),
		listProjects(pb),
		userTags(pb).catch(() => []),
		listSourceProjectNames(pb).catch(() => [])
	]);
	if (!row) error(404, t('item.notFound'));

	const urls = await imageUrls(pb, [row]);

	return {
		inspiration: row,
		imageUrl: urls[row.image_path] ?? null,
		projects,
		tags,
		sourceProjects
	};
};
