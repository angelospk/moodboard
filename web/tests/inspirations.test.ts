// Client-side data helpers, against a real PocketBase (the Go backend, started in tests/pb-server.ts).
import type PocketBase from 'pocketbase';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { createClient } from '../src/lib/pb';
import {
	copyInspiration,
	createInspiration,
	createProject,
	deleteInspiration,
	deleteProject,
	renameProject,
	setProjectArchived,
	deletePosition,
	getInspiration,
	imageUrls,
	isNewer,
	listInspirations,
	listProjects,
	loadPositions,
	savePositions,
	signUp,
	updateInspiration,
	userTags
} from '../src/lib/inspirations';

const URL_ = inject('pbUrl');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const png = () => new Blob([PNG], { type: 'image/png' });

let invite = '';
async function newUser(): Promise<{ pb: PocketBase; id: string }> {
	const pb = createClient(URL_);
	await signUp(pb, `c${crypto.randomUUID().slice(0, 8)}@example.com`, 'password123', invite);
	return { pb, id: pb.authStore.record!.id };
}

let A: { pb: PocketBase; id: string };
let B: { pb: PocketBase; id: string };
let p1: string;
let p2: string;

beforeAll(async () => {
	const admin = createClient(URL_);
	await admin.collection('_superusers').authWithPassword('admin@test.local', 'admin-password-1');
	await admin.settings.update({ rateLimits: { enabled: false } }); // tests sign in many users quickly
	invite = `T${crypto.randomUUID().slice(0, 8)}`;
	await admin.collection('invites').create({ code: invite, uses_left: 10 });
	A = await newUser();
	B = await newUser();
	p1 = (await createProject(A.pb, A.id, 'One')).id;
	p2 = (await createProject(A.pb, A.id, 'Two')).id;
});

describe('signUp', () => {
	it('needs a valid invite code', async () => {
		await expect(signUp(createClient(URL_), 'x1@example.com', 'password123', '')).rejects.toThrow();
		await expect(signUp(createClient(URL_), 'x2@example.com', 'password123', 'nope-nope')).rejects.toThrow(/δεν ισχύει/);
	});
});

describe('createInspiration', () => {
	it('uploads, inserts and normalizes tags', async () => {
		const { id } = await createInspiration(A.pb, A.id, png(), {
			project_id: p1, note: '  φως  ', tags: [' Ξύλο ', 'ξύλο', 'Φως'], level: 'detail'
		});
		const row = await getInspiration(A.pb, id);
		expect(row).toMatchObject({ project_id: p1, note: 'φως', tags: ['ξύλο', 'φως'], level: 'detail', regions: [] });
		expect(row!.image_path).toMatch(/\.png$/);
		const urls = await imageUrls(A.pb, [row!]);
		const res = await fetch(urls[row!.image_path]);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
	});

	it('maps empty optional fields to null', async () => {
		const { id } = await createInspiration(A.pb, A.id, png(), {});
		expect(await getInspiration(A.pb, id)).toMatchObject({ project_id: null, level: null, source_url: null, source_title: null, tags: [] });
	});

	it('rejects non-image types and big files before upload', async () => {
		await expect(createInspiration(A.pb, A.id, new Blob(['x'], { type: 'text/plain' }), {})).rejects.toThrow(/type/i);
		const big = new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/png' });
		await expect(createInspiration(A.pb, A.id, big, {})).rejects.toThrow(/10MB/);
	});

	it("cannot use another user's project", async () => {
		const bp = (await createProject(B.pb, B.id, 'B')).id;
		await expect(createInspiration(A.pb, A.id, png(), { project_id: bp })).rejects.toThrow();
	});

	it('image URLs do not work without a token', async () => {
		const [row] = await listInspirations(A.pb);
		const url = (await imageUrls(A.pb, [row]))[row.image_path].replace(/\?token=.*/, '');
		expect((await fetch(url)).status).toBe(404);
	});
});

describe('lists', () => {
	it('projects by name and only own rows', async () => {
		expect((await listProjects(A.pb)).map((p) => p.name)).toEqual(['One', 'Two']);
		expect((await listInspirations(B.pb)).length).toBe(0);
		const mine = await listInspirations(A.pb);
		expect(mine.length).toBeGreaterThan(0);
		expect(mine[0].created_at >= mine[mine.length - 1].created_at).toBe(true);
	});
});

describe('copyInspiration', () => {
	it('copies row and image into another project, original unchanged', async () => {
		const { id } = await createInspiration(A.pb, A.id, png(), {
			project_id: p1, note: 'n', tags: ['a'], level: 'material',
			regions: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, note: 'r' }], source_url: 'https://e.com'
		});
		const { id: copy } = await copyInspiration(A.pb, A.id, id, p2);
		expect(copy).not.toBe(id);
		const orig = (await getInspiration(A.pb, id))!;
		const dup = (await getInspiration(A.pb, copy))!;
		expect(orig.project_id).toBe(p1);
		expect(dup).toMatchObject({ project_id: p2, note: 'n', tags: ['a'], level: 'material', regions: orig.regions, source_url: 'https://e.com' });
		const urls = await imageUrls(A.pb, [dup]);
		expect((await fetch(urls[dup.image_path])).status).toBe(200);
	});

	it("cannot copy another user's inspiration", async () => {
		const { id } = await createInspiration(A.pb, A.id, png(), {});
		await expect(copyInspiration(B.pb, B.id, id, null)).rejects.toThrow();
	});
});

describe('userTags', () => {
	it('returns own tags, most used first, isolated per user', async () => {
		expect(await userTags(A.pb)).toEqual(expect.arrayContaining(['ξύλο', 'φως', 'a']));
		const C = await newUser();
		expect(await userTags(C.pb)).toEqual([]);
		await createInspiration(C.pb, C.id, png(), { tags: ['x', 'y'] });
		await createInspiration(C.pb, C.id, png(), { tags: ['y'] });
		expect(await userTags(C.pb)).toEqual(['y', 'x']);
	});
});

describe('map positions', () => {
	it('saves, updates and loads per scope, isolated per user', async () => {
		await savePositions(A.pb, p1, [{ key: 'i:x', x: 10, y: 20 }, { key: 't:ξύλο', x: -5.5, y: 3 }]);
		await savePositions(A.pb, p1, [{ key: 'i:x', x: 11, y: 21 }]);
		await savePositions(A.pb, 'all', [{ key: 'i:x', x: 99, y: 99 }]);
		expect(await loadPositions(A.pb, p1)).toEqual({ 'i:x': { x: 11, y: 21 }, 't:ξύλο': { x: -5.5, y: 3 } });
		expect(await loadPositions(A.pb, 'all')).toEqual({ 'i:x': { x: 99, y: 99 } });
		expect(await loadPositions(B.pb, p1)).toEqual({});
	});

	it('skips non-finite coordinates and empty input', async () => {
		await savePositions(A.pb, 'none', []);
		await savePositions(A.pb, 'none', [{ key: 'i:bad', x: NaN, y: 1 }, { key: 'i:ok', x: 1, y: Infinity }, { key: 'i:good', x: 1, y: 2 }]);
		expect(await loadPositions(A.pb, 'none')).toEqual({ 'i:good': { x: 1, y: 2 } });
	});

	it('deletes in one scope or in every scope', async () => {
		await savePositions(A.pb, 's1', [{ key: 't:k', x: 1, y: 1 }]);
		await savePositions(A.pb, 's2', [{ key: 't:k', x: 2, y: 2 }]);
		await deletePosition(A.pb, 's1', 't:k');
		expect(await loadPositions(A.pb, 's1')).toEqual({});
		expect(await loadPositions(A.pb, 's2')).toEqual({ 't:k': { x: 2, y: 2 } });
		await deletePosition(A.pb, null, 't:k');
		expect(await loadPositions(A.pb, 's2')).toEqual({});
		await savePositions(A.pb, 's3', [{ key: 'a:1', x: 1, y: 1 }, { key: 'a:2', x: 1, y: 1 }, { key: 'a:3', x: 1, y: 1 }]);
		await deletePosition(A.pb, 's3', ['a:1', 'a:2']);
		expect(await loadPositions(A.pb, 's3')).toEqual({ 'a:3': { x: 1, y: 1 } });
	});
});

describe('update and delete', () => {
	it('updates editable fields with clean tags and returns the row', async () => {
		const { id } = await createInspiration(A.pb, A.id, png(), { note: 'a', project_id: p1 });
		const row = await updateInspiration(A.pb, id, {
			note: ' b ', tags: ['Ξύλο', 'ξύλο'], level: 'detail', regions: [{ x: 0, y: 0, w: 0.5, h: 0.5, note: '', rating: 4 }]
		});
		expect(row).toMatchObject({ id, note: 'b', tags: ['ξύλο'], level: 'detail' });
		expect(row.regions[0].rating).toBe(4);
		expect(await updateInspiration(A.pb, id, { project_id: null, level: null })).toMatchObject({ project_id: null, level: null });
	});

	it('another user cannot update or delete', async () => {
		const { id } = await createInspiration(A.pb, A.id, png(), { note: 'mine' });
		await expect(updateInspiration(B.pb, id, { note: 'x' })).rejects.toThrow(/δεν βρέθηκε/);
		await expect(deleteInspiration(B.pb, id)).rejects.toThrow();
		expect((await getInspiration(A.pb, id))!.note).toBe('mine');
	});

	it('deletes the row and its image file', async () => {
		const { id } = await createInspiration(A.pb, A.id, png(), {});
		const row = (await getInspiration(A.pb, id))!;
		const url = (await imageUrls(A.pb, [row]))[row.image_path];
		await deleteInspiration(A.pb, id);
		expect(await getInspiration(A.pb, id)).toBeNull();
		expect((await fetch(url)).status).toBe(404);
	});
});

describe('project rename, archive, delete', () => {
	it('renames a project; a duplicate name is refused', async () => {
		const a = await createProject(A.pb, A.id, 'Old name');
		await createProject(A.pb, A.id, 'Taken');
		expect((await renameProject(A.pb, a.id, '  New name ')).name).toBe('New name');
		await expect(renameProject(A.pb, a.id, 'taken')).rejects.toThrow();
		expect((await listProjects(A.pb)).find((p) => p.id === a.id)?.name).toBe('New name');
	});

	it('archives and restores a project; images stay', async () => {
		const p = await createProject(A.pb, A.id, 'To archive');
		const row = await createInspiration(A.pb, A.id, png(), { project_id: p.id });
		expect((await listProjects(A.pb)).find((x) => x.id === p.id)?.archived).toBe(false);
		expect((await setProjectArchived(A.pb, p.id, true)).archived).toBe(true);
		expect((await listProjects(A.pb)).find((x) => x.id === p.id)?.archived).toBe(true);
		expect((await getInspiration(A.pb, row.id))?.project_id).toBe(p.id);
		expect((await setProjectArchived(A.pb, p.id, false)).archived).toBe(false);
	});

	it('deletes a project; its images become unassigned', async () => {
		const p = await createProject(A.pb, A.id, 'To delete');
		const row = await createInspiration(A.pb, A.id, png(), { project_id: p.id });
		await deleteProject(A.pb, p.id);
		expect((await listProjects(A.pb)).some((x) => x.id === p.id)).toBe(false);
		expect((await getInspiration(A.pb, row.id))?.project_id).toBeNull();
	});

	it("another user cannot rename, archive or delete", async () => {
		await expect(renameProject(B.pb, p1, 'Hacked')).rejects.toThrow();
		await expect(setProjectArchived(B.pb, p1, true)).rejects.toThrow();
		await expect(deleteProject(B.pb, p1)).rejects.toThrow();
	});
});

describe('isNewer', () => {
	it('applies only strictly newer rows', () => {
		const t = (s: string) => ({ updated_at: s });
		expect(isNewer(t('2026-11-11 08:00:00.002Z'), t('2026-11-11 08:00:00.001Z'))).toBe(true);
		expect(isNewer(t('2026-11-11 08:00:00.001Z'), t('2026-11-11 08:00:00.001Z'))).toBe(false);
		expect(isNewer(t('2026-11-11 07:59:59.999Z'), t('2026-11-11 08:00:00.000Z'))).toBe(false);
		expect(isNewer(t('2026-11-11 08:00:00.000Z'), undefined)).toBe(true);
	});
});
