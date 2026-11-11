// Share-link helpers against the real backend: the owner makes/revokes a link, anyone reads the board.
import type PocketBase from 'pocketbase';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { createClient } from '../src/lib/pb';
import { createInspiration, createProject, signUp } from '../src/lib/inspirations';
import { createShare, loadShared, revokeShare, shareStatus, sharedImageUrl, shareLink } from '../src/lib/share';

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
	ins = (await createInspiration(pb, uid, new Blob([PNG], { type: 'image/png' }), { project_id: project, note: 'φως', tags: ['ξύλο'] })).id;
});

describe('share links', () => {
	it('create → anonymous read with images → revoke', async () => {
		expect(await shareStatus(pb, project)).toMatchObject({ active: false });
		const token = await createShare(pb, project);
		expect(shareLink(token, 'https://app.example')).toBe(`https://app.example/s/${token}`);
		expect(await shareStatus(pb, project)).toMatchObject({ active: true });

		const board = await loadShared(token, URL_);
		expect(board.project.name).toBe('Κοινό');
		expect(board.inspirations).toHaveLength(1);
		expect(board.inspirations[0]).toMatchObject({ id: ins, note: 'φως', tags: ['ξύλο'], source_url: null });

		const img = await fetch(sharedImageUrl(token, ins, URL_));
		expect(img.status).toBe(200);
		expect(img.headers.get('content-type')).toBe('image/png');

		await revokeShare(pb, project);
		await expect(loadShared(token, URL_)).rejects.toThrow(/δεν ισχύει/);
		expect((await fetch(sharedImageUrl(token, ins, URL_))).status).toBe(404);
	});
});
