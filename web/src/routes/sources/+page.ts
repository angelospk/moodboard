import type { PageLoad } from './$types.js';
import { fileToken, imageUrls, listInspirations, listProjects, thumbUrl } from '#lib/inspirations.js';

export const load: PageLoad = async ({ parent, depends }) => {
	depends('moodboard:data');
	const { pb } = await parent();
	void fileToken(pb).catch(() => null);

	let error: string | null = null;
	let projects: Awaited<ReturnType<typeof listProjects>> = [];
	let inspirations: Awaited<ReturnType<typeof listInspirations>> = [];
	try {
		[projects, inspirations] = await Promise.all([listProjects(pb), listInspirations(pb)]);
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
	// Small images only: 480px thumbnails. A failed token drops the images, not the rows.
	const full = await imageUrls(pb, inspirations).catch((): Record<string, string> => ({}));
	const urls: Record<string, string> = {};
	for (const [k, v] of Object.entries(full)) urls[k] = thumbUrl(v)!;
	return { projects, inspirations, urls, error };
};
