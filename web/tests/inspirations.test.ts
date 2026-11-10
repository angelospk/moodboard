// Client-side data helpers, against local Supabase (real RLS + storage).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { copyInspiration, createInspiration, loadPositions, savePositions, userTags } from '../src/lib/inspirations';

const URL_ = 'http://127.0.0.1:54421';
const KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const png = () => new Blob([PNG], { type: 'image/png' });

async function newUser(): Promise<{ sb: SupabaseClient; id: string }> {
	const sb = createClient(URL_, KEY, { auth: { persistSession: false } });
	const { data, error } = await sb.auth.signUp({ email: `c${crypto.randomUUID().slice(0, 8)}@example.com`, password: 'password123' });
	if (error || !data.user) throw error ?? new Error('no user');
	return { sb, id: data.user.id };
}

let A: { sb: SupabaseClient; id: string };
let B: { sb: SupabaseClient; id: string };
let p1: string;
let p2: string;

beforeAll(async () => {
	A = await newUser();
	B = await newUser();
	p1 = (await A.sb.from('projects').insert({ name: 'One' }).select('id').single()).data!.id;
	p2 = (await A.sb.from('projects').insert({ name: 'Two' }).select('id').single()).data!.id;
});

describe('createInspiration', () => {
	it('uploads, inserts and normalizes tags', async () => {
		const { id } = await createInspiration(A.sb, A.id, png(), {
			project_id: p1, note: '  φως  ', tags: [' Ξύλο ', 'ξύλο', 'Φως'], level: 'detail'
		});
		const { data } = await A.sb.from('inspirations').select('*').eq('id', id).single();
		expect(data).toMatchObject({ project_id: p1, note: 'φως', tags: ['ξύλο', 'φως'], level: 'detail' });
		expect(data.image_path.startsWith(`${A.id}/`)).toBe(true);
		expect((await A.sb.storage.from('inspirations').download(data.image_path)).error).toBeNull();
	});

	it('rejects non-image types and big files before upload', async () => {
		await expect(createInspiration(A.sb, A.id, new Blob(['x'], { type: 'text/plain' }), {})).rejects.toThrow(/type/i);
		const big = new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/png' });
		await expect(createInspiration(A.sb, A.id, big, {})).rejects.toThrow(/10MB/);
	});

	it('removes the uploaded file when the insert fails', async () => {
		const before = (await A.sb.storage.from('inspirations').list(A.id)).data!.length;
		// B's project id is invisible to A, so the ownership trigger rejects the row.
		const bp = (await B.sb.from('projects').insert({ name: 'B' }).select('id').single()).data!.id;
		await expect(createInspiration(A.sb, A.id, png(), { project_id: bp })).rejects.toThrow();
		expect((await A.sb.storage.from('inspirations').list(A.id)).data!.length).toBe(before);
	});
});

describe('copyInspiration', () => {
	it('copies row and image into another project, original unchanged', async () => {
		const { id } = await createInspiration(A.sb, A.id, png(), {
			project_id: p1, note: 'n', tags: ['a'], level: 'material',
			regions: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, note: 'r' }], source_url: 'https://e.com'
		});
		const { id: copy } = await copyInspiration(A.sb, A.id, id, p2);
		expect(copy).not.toBe(id);
		const rows = (await A.sb.from('inspirations').select('*').in('id', [id, copy])).data!;
		const orig = rows.find((r) => r.id === id)!;
		const dup = rows.find((r) => r.id === copy)!;
		expect(orig.project_id).toBe(p1);
		expect(dup).toMatchObject({ project_id: p2, note: 'n', tags: ['a'], level: 'material', regions: orig.regions, source_url: 'https://e.com' });
		expect(dup.image_path).not.toBe(orig.image_path);
		expect((await A.sb.storage.from('inspirations').download(dup.image_path)).error).toBeNull();
	});

	it('cannot copy another user\'s inspiration', async () => {
		const { id } = await createInspiration(A.sb, A.id, png(), {});
		await expect(copyInspiration(B.sb, B.id, id, null)).rejects.toThrow();
	});
});

describe('userTags', () => {
	it('returns own tags, most used first, isolated per user', async () => {
		const tags = await userTags(A.sb);
		expect(tags).toEqual(expect.arrayContaining(['ξύλο', 'φως', 'a']));
		expect(await userTags(B.sb)).toEqual([]);
		const C = await newUser();
		await createInspiration(C.sb, C.id, png(), { tags: ['x', 'y'] });
		await createInspiration(C.sb, C.id, png(), { tags: ['y'] });
		expect(await userTags(C.sb)).toEqual(['y', 'x']);
	});
});

describe('map positions', () => {
	it('saves, updates and loads per scope, isolated per user', async () => {
		await savePositions(A.sb, p1, [{ key: 'i:x', x: 10, y: 20 }, { key: 't:ξύλο', x: -5.5, y: 3 }]);
		await savePositions(A.sb, p1, [{ key: 'i:x', x: 11, y: 21 }]);
		await savePositions(A.sb, 'all', [{ key: 'i:x', x: 99, y: 99 }]);
		expect(await loadPositions(A.sb, p1)).toEqual({ 'i:x': { x: 11, y: 21 }, 't:ξύλο': { x: -5.5, y: 3 } });
		expect(await loadPositions(A.sb, 'all')).toEqual({ 'i:x': { x: 99, y: 99 } });
		expect(await loadPositions(B.sb, p1)).toEqual({});
	});

	it('skips non-finite coordinates and empty input', async () => {
		await savePositions(A.sb, 'none', []);
		await savePositions(A.sb, 'none', [{ key: 'i:bad', x: NaN, y: 1 }, { key: 'i:ok', x: 1, y: Infinity }, { key: 'i:good', x: 1, y: 2 }]);
		expect(await loadPositions(A.sb, 'none')).toEqual({ 'i:good': { x: 1, y: 2 } });
	});
});
