import type { PageLoad } from './$types';
import { BUCKET, type Inspiration, type Project } from '#lib/types.js';
import { userTags } from '#lib/inspirations.js';

export const load: PageLoad = async ({ parent, depends }) => {
	depends('moodboard:data');
	const { supabase, user } = await parent();

	// PostgREST returns at most 1000 rows per request, so read in pages until a short page.
	const PAGE = 1000;
	async function all<T>(query: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>) {
		const rows: T[] = [];
		for (let from = 0; ; from += PAGE) {
			const { data, error } = await query(from, from + PAGE - 1);
			if (error) return { rows, error };
			rows.push(...((data ?? []) as T[]));
			if (!data || data.length < PAGE) return { rows, error: null };
		}
	}

	const [projectsRes, inspirationsRes] = await Promise.all([
		all<Project>((from, to) =>
			supabase.from('projects').select('id, name, description, created_at').order('name').order('id').range(from, to)
		),
		all<Inspiration>((from, to) =>
			supabase
				.from('inspirations')
				.select(
					'id, project_id, tags, level, note, image_path, regions, source_url, source_title, created_at'
				)
				.order('created_at', { ascending: false })
				.order('id')
				.range(from, to)
		)
	]);
	const err = projectsRes.error ?? inspirationsRes.error;
	const projects = projectsRes.rows;
	const inspirations = inspirationsRes.rows;

	// One batch call for every signed image URL (valid for an hour).
	const urls: Record<string, string> = {};
	if (inspirations.length) {
		const { data: signed } = await supabase.storage
			.from(BUCKET)
			.createSignedUrls(inspirations.map((i) => i.image_path), 3600);
		for (const s of signed ?? []) {
			if (s.path && s.signedUrl) urls[s.path] = s.signedUrl;
		}
	}

	const tags = await userTags(supabase).catch(() => []);

	return { projects, inspirations, urls, tags, userId: user?.id, error: err ? err.message : null };
};
