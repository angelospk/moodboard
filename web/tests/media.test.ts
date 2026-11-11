// Image speed (thumbnails, one long-lived file token) and the new fields image_url and crop.
import type PocketBase from 'pocketbase';
import { beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createClient } from '../src/lib/pb';
import { createInspiration, getInspiration, imageUrls, newId, signUp, thumbUrl, updateInspiration } from '../src/lib/inspirations';

const URL_ = inject('pbUrl');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const png = () => new Blob([PNG], { type: 'image/png' });

let invite = '';
async function newUser(): Promise<{ pb: PocketBase; id: string }> {
	const pb = createClient(URL_);
	await signUp(pb, `m${crypto.randomUUID().slice(0, 8)}@example.com`, 'password123', invite);
	return { pb, id: pb.authStore.record!.id };
}

let A: { pb: PocketBase; id: string };
let B: { pb: PocketBase; id: string };

beforeAll(async () => {
	const admin = createClient(URL_);
	await admin.collection('_superusers').authWithPassword('admin@test.local', 'admin-password-1');
	await admin.settings.update({ rateLimits: { enabled: false } });
	invite = `M${crypto.randomUUID().slice(0, 8)}`;
	await admin.collection('invites').create({ code: invite, uses_left: 10 });
	A = await newUser();
	B = await newUser();
});

describe('image URLs', () => {
	it('reuse one file token across calls, so URLs stay the same and the browser cache works', async () => {
		const { id } = await createInspiration(A.pb, A.id, png(), {});
		const row = (await getInspiration(A.pb, id))!;
		const spy = vi.spyOn(A.pb.files, 'getToken');
		const first = (await imageUrls(A.pb, [row]))[row.image_path];
		const second = (await imageUrls(A.pb, [row]))[row.image_path];
		expect(second).toBe(first);
		expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
		expect((await fetch(first)).status).toBe(200);
	});

	it('keeps tokens per user', async () => {
		const a = (await createInspiration(A.pb, A.id, png(), {})).id;
		const b = (await createInspiration(B.pb, B.id, png(), {})).id;
		const ra = (await getInspiration(A.pb, a))!;
		const rb = (await getInspiration(B.pb, b))!;
		const ua = (await imageUrls(A.pb, [ra]))[ra.image_path];
		const ub = (await imageUrls(B.pb, [rb]))[rb.image_path];
		expect(new URL(ua).searchParams.get('token')).not.toBe(new URL(ub).searchParams.get('token'));
		expect((await fetch(ub)).status).toBe(200);
	});

	it('thumbUrl asks for the 480px thumbnail and leaves local blob URLs alone', async () => {
		const { id } = await createInspiration(A.pb, A.id, png(), {});
		const row = (await getInspiration(A.pb, id))!;
		const url = (await imageUrls(A.pb, [row]))[row.image_path];
		const t = thumbUrl(url)!;
		expect(new URL(t).searchParams.get('thumb')).toBe('480x0');
		expect(new URL(t).searchParams.get('token')).toBe(new URL(url).searchParams.get('token'));
		expect((await fetch(t)).status).toBe(200);
		expect(thumbUrl('blob:http://x/1')).toBe('blob:http://x/1');
		expect(thumbUrl(null)).toBeNull();
	});
});

describe('image_url and crop', () => {
	it('round-trip and map to null when empty', async () => {
		const { id } = await createInspiration(A.pb, A.id, png(), {
			image_url: 'https://example.com/a.jpg',
			crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.4 }
		});
		expect(await getInspiration(A.pb, id)).toMatchObject({
			image_url: 'https://example.com/a.jpg',
			crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.4 }
		});
		expect(await updateInspiration(A.pb, id, { crop: null })).toMatchObject({ crop: null });
		const plain = (await createInspiration(A.pb, A.id, png(), {})).id;
		expect(await getInspiration(A.pb, plain)).toMatchObject({ image_url: null, crop: null });
	});

	it('rejects a crop outside the image', async () => {
		const { id } = await createInspiration(A.pb, A.id, png(), {});
		await expect(updateInspiration(A.pb, id, { crop: { x: 0.8, y: 0, w: 0.5, h: 0.5 } })).rejects.toThrow();
	});
});

describe('optimistic create', () => {
	it('uses an id made by the client and returns the stored row', async () => {
		const id = newId();
		expect(id).toMatch(/^[a-z0-9]{15}$/);
		const row = await createInspiration(A.pb, A.id, png(), { id, tags: ['Α'] });
		expect(row).toMatchObject({ id, tags: ['α'] });
		expect(row.image_path).toMatch(/\.png$/);
		await expect(createInspiration(A.pb, A.id, png(), { id })).rejects.toThrow();
	});
});
