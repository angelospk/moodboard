import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types.js';
import { listVersions, loadDraft, type VersionInfo } from '#lib/house/store.js';
import { emptyModel, type HouseModel } from '#lib/house/model.js';

// /house?project=<id>: the 3D house editor of one project. The draft and the version list come from
// the server on every visit, so another device's last state shows after a refresh.
export const load: PageLoad = async ({ parent, url }) => {
	const { pb, user } = await parent();
	const projectId = url.searchParams.get('project');
	if (!projectId) redirect(307, '/map');

	let error: string | null = null;
	let project = { id: projectId, name: '' };
	let model: HouseModel = emptyModel();
	let versions: VersionInfo[] = [];
	let hasDraft = false;
	try {
		const [p, draft, list] = await Promise.all([
			pb.collection('projects').getOne(projectId, { fields: 'id,name' }),
			loadDraft(pb, projectId),
			listVersions(pb, projectId)
		]);
		project = { id: p.id, name: p.name as string };
		if (draft) {
			model = draft.model;
			hasDraft = true;
		}
		versions = list;
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
	return { pb, userId: user!.id, project, model, versions, hasDraft, error };
};
