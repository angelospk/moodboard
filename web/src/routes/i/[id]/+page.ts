import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types.js';
import { getInspiration, imageUrls, listProjects, userTags } from '#lib/inspirations.js';

export const load: PageLoad = async ({ params, parent, depends }) => {
	depends('moodboard:data');
	const { pb } = await parent();

	const [row, projects, tags] = await Promise.all([
		getInspiration(pb, params.id),
		listProjects(pb),
		userTags(pb).catch(() => [])
	]);
	if (!row) error(404, 'Η εικόνα δεν βρέθηκε');

	const urls = await imageUrls(pb, [row]);

	return {
		inspiration: row,
		imageUrl: urls[row.image_path] ?? null,
		projects,
		tags
	};
};
