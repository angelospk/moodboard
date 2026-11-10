import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { BUCKET, type Inspiration, type Project } from '#lib/types.js';
import { userTags } from '#lib/inspirations.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const load: PageLoad = async ({ params, parent, depends }) => {
	depends('moodboard:data');
	if (!UUID.test(params.id)) error(404, 'Η εικόνα δεν βρέθηκε');

	const { supabase } = await parent();
	const [row, projectsRes, tags] = await Promise.all([
		supabase.from('inspirations').select('*').eq('id', params.id).maybeSingle(),
		supabase.from('projects').select('id, name, description, created_at').order('name'),
		userTags(supabase).catch(() => [])
	]);
	if (row.error) error(500, row.error.message);
	if (!row.data) error(404, 'Η εικόνα δεν βρέθηκε');

	const inspiration = row.data as Inspiration;
	const signed = await supabase.storage.from(BUCKET).createSignedUrl(inspiration.image_path, 3600);

	return {
		inspiration,
		imageUrl: signed.data?.signedUrl ?? null,
		projects: (projectsRes.data ?? []) as Project[],
		tags
	};
};
