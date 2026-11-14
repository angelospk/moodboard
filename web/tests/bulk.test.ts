// Acting on several images at once (the similar images of the image page), against a real PocketBase.
import type PocketBase from 'pocketbase';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { createClient } from '../src/lib/pb';
import { copyInspiration, createInspiration, createProject, getInspiration, signUp, updateMany } from '../src/lib/inspirations';
import { cleanSource } from '../src/lib/inspirations';
import { suggestStored } from '../src/lib/suggest';

const URL_ = inject('pbUrl');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const png = () => new Blob([PNG], { type: 'image/png' });

let invite = '';
async function newUser(): Promise<{ pb: PocketBase; id: string }> {
	const pb = createClient(URL_);
	await signUp(pb, `b${crypto.randomUUID().slice(0, 8)}@example.com`, 'password123', invite);
	return { pb, id: pb.authStore.record!.id };
}

let A: { pb: PocketBase; id: string };
let B: { pb: PocketBase; id: string };

beforeAll(async () => {
	const admin = createClient(URL_);
	await admin.collection('_superusers').authWithPassword('admin@test.local', 'admin-password-1');
	invite = `B${crypto.randomUUID().slice(0, 8)}`;
	await admin.collection('invites').create({ code: invite, uses_left: 10 });
	A = await newUser();
	B = await newUser();
});

describe('cleanSource', () => {
	it('keeps an http(s) address and trims it', () => {
		expect(cleanSource('  https://example.com/a?b=1 ')).toBe('https://example.com/a?b=1');
		expect(cleanSource('http://x.gr')).toBe('http://x.gr');
	});
	it('adds https:// to a bare host', () => {
		expect(cleanSource('pinterest.com/pin/1')).toBe('https://pinterest.com/pin/1');
	});
	it('refuses other schemes and empty text', () => {
		expect(cleanSource('javascript:alert(1)')).toBeNull();
		expect(cleanSource('ftp://x.gr/a')).toBeNull();
		expect(cleanSource('   ')).toBeNull();
		expect(cleanSource('δεν είναι διεύθυνση')).toBeNull();
	});
});

describe('updateMany', () => {
	it('moves several images to a project and gives them one source', async () => {
		const p = (await createProject(A.pb, A.id, 'Κοινό')).id;
		const a = await createInspiration(A.pb, A.id, png(), { project_id: null });
		const b = await createInspiration(A.pb, A.id, png(), { project_id: null, note: 'μένει' });
		const out = await updateMany(A.pb, [a.id, b.id], {
			project_id: p,
			source_url: 'https://example.com/board',
			source_title: 'Board'
		});
		expect(out).toEqual({ ok: [a.id, b.id], failed: [] });
		for (const id of [a.id, b.id]) {
			const r = (await getInspiration(A.pb, id))!;
			expect(r.project_id).toBe(p);
			expect(r.source_url).toBe('https://example.com/board');
			expect(r.source_title).toBe('Board');
		}
		expect((await getInspiration(A.pb, b.id))!.note).toBe('μένει');
	});

	it('reports the images it could not change and still changes the others', async () => {
		const mine = await createInspiration(A.pb, A.id, png(), { project_id: null });
		const theirs = await createInspiration(B.pb, B.id, png(), { project_id: null });
		const out = await updateMany(A.pb, [mine.id, theirs.id], { source_url: 'https://example.com/x' });
		expect(out.ok).toEqual([mine.id]);
		expect(out.failed).toEqual([theirs.id]);
		expect((await getInspiration(B.pb, theirs.id))!.source_url).toBeNull();
	});

	it('does nothing for no ids', async () => {
		expect(await updateMany(A.pb, [], { project_id: null })).toEqual({ ok: [], failed: [] });
	});

	it('sets the source project of several stored images at once, and clears it', async () => {
		const a = await createInspiration(A.pb, A.id, png(), { project_id: null });
		const b = await createInspiration(A.pb, A.id, png(), { project_id: null, note: 'μένει' });
		expect((await getInspiration(A.pb, a.id))!.source_project).toBeNull();
		const out = await updateMany(A.pb, [a.id, b.id], { source_project: '  Villa   Savoye ' });
		expect(out).toEqual({ ok: [a.id, b.id], failed: [] });
		for (const id of [a.id, b.id]) expect((await getInspiration(A.pb, id))!.source_project).toBe('Villa Savoye');
		expect((await getInspiration(A.pb, b.id))!.note).toBe('μένει');
		await updateMany(A.pb, [a.id], { source_project: null });
		expect((await getInspiration(A.pb, a.id))!.source_project).toBeNull();
		expect((await getInspiration(A.pb, b.id))!.source_project).toBe('Villa Savoye');
	});

	it('keeps the source project when an image is created with it, and when it is copied', async () => {
		const p = (await createProject(A.pb, A.id, 'Αντίγραφο')).id;
		const a = await createInspiration(A.pb, A.id, png(), { project_id: null, source_project: 'Casa' });
		expect((await getInspiration(A.pb, a.id))!.source_project).toBe('Casa');
		const copy = await copyInspiration(A.pb, A.id, a.id, p);
		expect((await getInspiration(A.pb, copy.id))!.source_project).toBe('Casa');
	});
});

describe('suggestStored', () => {
	it('gives null when the server has no AI key (the test server has none)', async () => {
		const i = await createInspiration(A.pb, A.id, png(), { project_id: null });
		await A.pb.collection('users').update(A.id, { ai_enabled: true });
		expect(await suggestStored(A.pb, i.id)).toEqual({ kind: 'off' });
	});
});
