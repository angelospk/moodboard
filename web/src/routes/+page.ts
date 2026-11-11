import type { PageLoad } from './$types.js';
import { imageUrls, listInspirations, listProjects } from '#lib/inspirations.js';

export const load: PageLoad = async ({ parent, depends }) => {
	depends('moodboard:data');
	const { pb, user } = await parent();

	let error: string | null = null;
	let projects: Awaited<ReturnType<typeof listProjects>> = [];
	let inspirations: Awaited<ReturnType<typeof listInspirations>> = [];
	try {
		[projects, inspirations] = await Promise.all([listProjects(pb), listInspirations(pb)]);
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}

	// One file token for every image URL (valid for an hour). A failed token only drops the thumbnails:
	// it must not hide the rows. This mirrors the old signed-URL call that never failed the load.
	const urls = await imageUrls(pb, inspirations).catch((): Record<string, string> => ({}));

	return { projects, inspirations, urls, userId: user?.id, error };
};
