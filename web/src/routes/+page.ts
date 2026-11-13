import { invalidate } from '$app/navigation';
import type { PageLoad } from './$types.js';
import { swrLoad } from '#lib/datacache.js';
import { fileToken, imageUrls, listInspirations, listProjects, thumbUrl } from '#lib/inspirations.js';

export const load: PageLoad = async ({ parent, depends }) => {
	depends('moodboard:data');
	const { pb, user } = await parent();

	// Ask for the file token while the rows load (usually it comes from the cache, with no request).
	void fileToken(pb).catch(() => null);

	let error: string | null = null;
	let projects: Awaited<ReturnType<typeof listProjects>> = [];
	let inspirations: Awaited<ReturnType<typeof listInspirations>> = [];
	try {
		// The last known rows at once; the server's answer replaces them when it differs.
		({ projects, inspirations } = await swrLoad(
			`rows:${user!.id}`,
			async () => {
				const [p, i] = await Promise.all([listProjects(pb), listInspirations(pb)]);
				return { projects: p, inspirations: i };
			},
			() => void invalidate('moodboard:data')
		));
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}

	// This page shows only small images: 480px thumbnails. A failed token only drops the images: it
	// must not hide the rows.
	const full = await imageUrls(pb, inspirations).catch((): Record<string, string> => ({}));
	const urls: Record<string, string> = {};
	for (const [k, v] of Object.entries(full)) urls[k] = thumbUrl(v)!;

	return { projects, inspirations, urls, userId: user?.id, error };
};
