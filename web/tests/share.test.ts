// Public boards against the real backend: the owner turns a board public and picks what shows.
import type PocketBase from 'pocketbase';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { createClient } from '../src/lib/pb';
import { createInspiration, createProject, signUp } from '../src/lib/inspirations';
import { getShare, loadPublic, publicImageUrl, publicLink, saveShare, SHARE_DEFAULTS } from '../src/lib/share';

const URL_ = inject('pbUrl');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

let pb: PocketBase;
let project = '';
let ins = '';

beforeAll(async () => {
	const admin = createClient(URL_);
	await admin.collection('_superusers').authWithPassword('admin@test.local', 'admin-password-1');
	const invite = `S${crypto.randomUUID().slice(0, 8)}`;
	await admin.collection('invites').create({ code: invite, uses_left: 1 });
	pb = createClient(URL_);
	await signUp(pb, `s${crypto.randomUUID().slice(0, 8)}@example.com`, 'password123', invite);
	const uid = pb.authStore.record!.id;
	project = (await createProject(pb, uid, 'Κοινό')).id;
	ins = (await createInspiration(pb, uid, new Blob([PNG], { type: 'image/png' }), {
		project_id: project, note: 'φως', tags: ['ξύλο'], source_url: 'https://site.example/a'
	})).id;
});

describe('public boards', () => {
	it('off by default → on with defaults → options → off', async () => {
		expect(await getShare(pb, project)).toEqual(SHARE_DEFAULTS);
		expect(SHARE_DEFAULTS).toEqual({ public: false, notes: true, regions: true, tags: true, sources: false });
		await expect(loadPublic(project, URL_)).rejects.toThrow(/δεν είναι δημόσιο/);
		expect(publicLink(project, 'https://app.example')).toBe(`https://app.example/s/${project}`);

		await saveShare(pb, project, { ...SHARE_DEFAULTS, public: true });
		let board = await loadPublic(project, URL_);
		expect(board.project.name).toBe('Κοινό');
		expect(board.inspirations[0]).toMatchObject({ id: ins, note: 'φως', tags: ['ξύλο'], source_url: null });
		const img = await fetch(publicImageUrl(project, ins, URL_));
		expect(img.status).toBe(200);
		expect(img.headers.get('content-type')).toBe('image/png');

		await saveShare(pb, project, { public: true, notes: false, regions: true, tags: false, sources: true });
		expect(await getShare(pb, project)).toEqual({ public: true, notes: false, regions: true, tags: false, sources: true });
		board = await loadPublic(project, URL_);
		expect(board.inspirations[0]).toMatchObject({ note: '', tags: [], source_url: 'https://site.example/a' });

		// Partial saves touch only their own field.
		await saveShare(pb, project, { sources: false });
		expect(await getShare(pb, project)).toEqual({ public: true, notes: false, regions: true, tags: false, sources: false });

		await saveShare(pb, project, { public: false });
		await expect(loadPublic(project, URL_)).rejects.toThrow(/δεν είναι δημόσιο/);
		expect((await fetch(publicImageUrl(project, ins, URL_))).status).toBe(404);
	});
});
