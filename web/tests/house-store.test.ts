// House models against the real backend: one autosaved draft per project, named versions, owner only.
import type PocketBase from 'pocketbase';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { createClient } from '../src/lib/pb';
import { createProject, signUp } from '../src/lib/inspirations';
import { listVersions, loadDraft, loadVersion, saveDraft, saveVersion, trackDraftSave } from '../src/lib/house/store';
import { emptyModel, type HouseModel } from '../src/lib/house/model';

const URL_ = inject('pbUrl');

async function user(): Promise<{ pb: PocketBase; uid: string }> {
	const admin = createClient(URL_);
	await admin.collection('_superusers').authWithPassword('admin@test.local', 'admin-password-1');
	const invite = `H${crypto.randomUUID().slice(0, 8)}`;
	await admin.collection('invites').create({ code: invite, uses_left: 1 });
	const pb = createClient(URL_);
	await signUp(pb, `h${crypto.randomUUID().slice(0, 8)}@example.com`, 'password123', invite);
	return { pb, uid: pb.authStore.record!.id };
}

const withWall = (len: number): HouseModel => ({
	...emptyModel(),
	elements: [{ id: 'w1', type: 'wall', name: '', material: 'concrete', points: [[0, 0], [len, 0]], height: 3, thickness: 0.25, base: 0 }]
});

let a: { pb: PocketBase; uid: string };
let b: { pb: PocketBase; uid: string };
let project = '';

beforeAll(async () => {
	[a, b] = await Promise.all([user(), user()]);
	project = (await createProject(a.pb, a.uid, 'Σπίτι')).id;
});

describe('house drafts', () => {
	it('no draft at first; saving twice keeps one draft with the last model', async () => {
		expect(await loadDraft(a.pb, project)).toBeNull();
		await saveDraft(a.pb, a.uid, project, withWall(4));
		await saveDraft(a.pb, a.uid, project, withWall(6));
		expect((await loadDraft(a.pb, project))!.model).toEqual(withWall(6));
		const rows = await a.pb.collection('house_models').getFullList({ filter: `project_id = "${project}" && kind = "draft"` });
		expect(rows).toHaveLength(1);
	});

	it('saveDraft returns the row id; with it the next save is one update of the same row', async () => {
		const p = (await createProject(a.pb, a.uid, 'Με id')).id;
		const id = await saveDraft(a.pb, a.uid, p, withWall(1));
		expect(await saveDraft(a.pb, a.uid, p, withWall(2), id)).toBe(id);
		expect((await loadDraft(a.pb, p))!.model).toEqual(withWall(2));
		// A known id whose row is gone: create the draft again.
		await a.pb.collection('house_models').delete(id);
		const again = await saveDraft(a.pb, a.uid, p, withWall(3), id);
		expect(again).not.toBe(id);
		expect((await loadDraft(a.pb, p))!.model).toEqual(withWall(3));
	});

	it('a load waits for a draft save still running in this tab', async () => {
		const p = (await createProject(a.pb, a.uid, 'Πήγαινε-έλα')).id;
		await saveDraft(a.pb, a.uid, p, withWall(1));
		void saveDraft(a.pb, a.uid, p, withWall(9));
		expect((await loadDraft(a.pb, p))!.model).toEqual(withWall(9));
	});

	it('a load also waits for a tracked save queue whose write has not started yet', async () => {
		const p = (await createProject(a.pb, a.uid, 'Ουρά')).id;
		await saveDraft(a.pb, a.uid, p, withWall(1));
		const queue = new Promise((r) => setTimeout(r, 300)).then(() => saveDraft(a.pb, a.uid, p, withWall(7)));
		trackDraftSave(p, queue);
		expect((await loadDraft(a.pb, p))!.model).toEqual(withWall(7));
	});

	it('two drafts saved at once still leave one row', async () => {
		const p = (await createProject(a.pb, a.uid, 'Παράλληλο')).id;
		await Promise.all([saveDraft(a.pb, a.uid, p, withWall(1)), saveDraft(a.pb, a.uid, p, withWall(2))]);
		const rows = await a.pb.collection('house_models').getFullList({ filter: `project_id = "${p}" && kind = "draft"` });
		expect(rows).toHaveLength(1);
	});

	it('loaded models go through parseModel (broken elements dropped)', async () => {
		const p = (await createProject(a.pb, a.uid, 'Χαλασμένο')).id;
		await a.pb.collection('house_models').create({ user_id: a.uid, project_id: p, kind: 'draft', name: '', model: { elements: [{ type: 'rocket' }, ...withWall(2).elements] } });
		expect((await loadDraft(a.pb, p))!.model).toEqual(withWall(2));
	});
});

describe('house versions', () => {
	it('saves named versions, lists newest first, opens an old one', async () => {
		const v1 = await saveVersion(a.pb, a.uid, project, 'Πρώτη ιδέα', withWall(3));
		const v2 = await saveVersion(a.pb, a.uid, project, '  Με πισίνα  ', withWall(8));
		expect(v1).toMatchObject({ name: 'Πρώτη ιδέα' });
		expect(v2.name).toBe('Με πισίνα');
		const list = await listVersions(a.pb, project);
		expect(list.map((v) => v.id)).toEqual([v2.id, v1.id]);
		expect(list[0]).toEqual({ id: v2.id, name: 'Με πισίνα', created_at: expect.any(String) });
		expect(await loadVersion(a.pb, v1.id)).toEqual(withWall(3));
		// The draft is not a version.
		expect(list.every((v) => v.name !== '')).toBe(true);
	});

	it('an empty name gets a dated default', async () => {
		const v = await saveVersion(a.pb, a.uid, project, '   ', withWall(1));
		expect(v.name.length).toBeGreaterThan(0);
	});
});

describe('house rules', () => {
	it('another user cannot read or write my models', async () => {
		expect(await listVersions(b.pb, project)).toEqual([]);
		expect(await loadDraft(b.pb, project)).toBeNull();
		await expect(saveVersion(b.pb, b.uid, project, 'ξένο', withWall(1))).rejects.toThrow();
		await expect(saveDraft(b.pb, b.uid, project, withWall(1))).rejects.toThrow();
	});

	it('another user cannot get, update or delete my rows by id', async () => {
		const v = await saveVersion(a.pb, a.uid, project, 'μυστικό', withWall(2));
		const col = b.pb.collection('house_models');
		await expect(col.getOne(v.id)).rejects.toMatchObject({ status: 404 });
		await expect(col.update(v.id, { name: 'κλεμμένο' })).rejects.toMatchObject({ status: 404 });
		await expect(col.delete(v.id)).rejects.toMatchObject({ status: 404 });
		expect(await loadVersion(a.pb, v.id)).toEqual(withWall(2));
	});

	it('a model cannot move to a project of another user', async () => {
		const foreign = (await createProject(b.pb, b.uid, 'Ξένο')).id;
		const v = await saveVersion(a.pb, a.uid, project, 'δικό', withWall(1));
		await expect(a.pb.collection('house_models').update(v.id, { project_id: foreign })).rejects.toThrow();
		expect((await a.pb.collection('house_models').getOne(v.id)).project_id).toBe(project);
	});

	it('a model needs a project I own and cannot move to another user', async () => {
		await expect(
			b.pb.collection('house_models').create({ user_id: b.uid, project_id: project, kind: 'version', name: 'x', model: emptyModel() })
		).rejects.toThrow();
		const v = await saveVersion(a.pb, a.uid, project, 'δικό μου', withWall(1));
		await expect(a.pb.collection('house_models').update(v.id, { user_id: b.uid })).rejects.toThrow();
	});
});
