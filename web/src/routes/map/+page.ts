import type { PageLoad } from './$types';
import { BUCKET, type Inspiration, type Project } from '#lib/types.js';

export const load: PageLoad = async ({ parent, depends }) => {
	depends('moodboard:data');
	const { supabase } = await parent();

	const [projectsRes, inspirationsRes] = await Promise.all([
		supabase.from('projects').select('id, name, description, created_at').order('name'),
		supabase
			.from('inspirations')
			.select('id, project_id, tags, level, note, image_path, regions')
			.order('created_at', { ascending: false })
	]);
	const err = projectsRes.error ?? inspirationsRes.error;
	const projects = (projectsRes.data ?? []) as Project[];
	const inspirations = (inspirationsRes.data ?? []) as Inspiration[];

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

	return { projects, inspirations, urls, error: err ? err.message : null };
};
