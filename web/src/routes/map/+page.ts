import { invalidate } from '$app/navigation';
import type { PageLoad } from './$types.js';
import { swrLoad } from '#lib/datacache.js';
import { fileToken, imageUrls, listInspirations, listProjects, loadPositions, userTags } from '#lib/inspirations.js';

export const load: PageLoad = async ({ parent, depends, url }) => {
	depends('moodboard:data');
	const { pb, user } = await parent();

	// Saved node positions belong to one map: a project id, 'none' or 'all'. Reading the URL here
	// makes the load re-run when `?project=` changes.
	const param = url.searchParams.get('project');
	const scope = param && param !== 'all' ? param : 'all';

	// Everything that does not need the rows starts at once: one round trip instead of three.
	void fileToken(pb).catch(() => null);
	// Rows and tags: the last known copy at once, the server's answer when it differs (see datacache.ts).
	const uid = user!.id;
	const refresh = () => void invalidate('moodboard:data');
	const extras = Promise.all([
		swrLoad(`tags:${uid}`, () => userTags(pb), refresh).catch((): string[] => []),
		// Positions always come from the server: the board reads them only when it opens a scope, so a
		// cached copy that is out of date (moved on another device) would stay on screen.
		loadPositions(pb, scope).catch((): Record<string, { x: number; y: number }> => ({}))
	]);

	let error: string | null = null;
	let projects: Awaited<ReturnType<typeof listProjects>> = [];
	let inspirations: Awaited<ReturnType<typeof listInspirations>> = [];
	try {
		({ projects, inspirations } = await swrLoad(
			`rows:${uid}`,
			async () => {
				const [p, i] = await Promise.all([listProjects(pb), listInspirations(pb)]);
				return { projects: p, inspirations: i };
			},
			refresh
		));
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}

	// Full-size URLs (the side panel); the board asks for thumbnails itself. A failed token only drops
	// the images: it must not hide the rows.
	const urls = await imageUrls(pb, inspirations).catch((): Record<string, string> => ({}));
	const [tags, positions] = await extras;

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
