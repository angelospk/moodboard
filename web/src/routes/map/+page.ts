import type { PageLoad } from './$types.js';
import { imageUrls, listInspirations, listProjects, loadPositions, userTags } from '#lib/inspirations.js';

export const load: PageLoad = async ({ parent, depends, url }) => {
	depends('moodboard:data');
	const { pb, user } = await parent();

	// Saved node positions belong to one map: a project id, 'none' or 'all'. Reading the URL here
	// makes the load re-run when `?project=` changes.
	const param = url.searchParams.get('project');
	const scope = param && param !== 'all' ? param : 'all';

	let error: string | null = null;
	let projects: Awaited<ReturnType<typeof listProjects>> = [];
	let inspirations: Awaited<ReturnType<typeof listInspirations>> = [];
	try {
		[projects, inspirations] = await Promise.all([listProjects(pb), listInspirations(pb)]);
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}

	// One file token for every image URL (valid for an hour). A failed token only drops the thumbnails:
	// it must not hide the rows.
	const urls = await imageUrls(pb, inspirations).catch((): Record<string, string> => ({}));

	const [tags, positions] = await Promise.all([
		userTags(pb).catch(() => []),
		loadPositions(pb, scope).catch((): Record<string, { x: number; y: number }> => ({}))
	]);

	return {
		projects,
		inspirations,
		urls,
		tags,
		positions,
		positionsScope: scope,
		userId: user?.id,
		error
	};
};
