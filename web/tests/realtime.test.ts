import type PocketBase from 'pocketbase';
import type { RecordModel } from 'pocketbase';
import { describe, expect, inject, it } from 'vitest';
import { applyEvent, subscribeLive } from '../src/lib/realtime';
import { createClient } from '../src/lib/pb';
import { createInspiration, deleteInspiration, signUp, updateInspiration } from '../src/lib/inspirations';
import type { Inspiration } from '../src/lib/types';

const rec = (id: string, updated: string, note = ''): RecordModel =>
	({ id, collectionId: 'c', collectionName: 'inspirations', image: `${id}.png`, note, tags: [], regions: [], updated_at: updated, created_at: updated }) as RecordModel;
const row = (id: string, updated: string, note = '') => applyEvent([], { action: 'create', record: rec(id, updated, note) })[0];

describe('applyEvent', () => {
	const a = row('a', '2026-11-11 08:00:00.100Z', 'old');
	const items: Inspiration[] = [a];

	it('adds a new row on top, ignores a create of a shown row', () => {
		expect(applyEvent(items, { action: 'create', record: rec('b', '2026-11-11 08:00:01.000Z') }).map((i) => i.id)).toEqual(['b', 'a']);
		expect(applyEvent(items, { action: 'create', record: rec('a', '2026-11-11 08:00:00.100Z') })).toBe(items);
	});

	it('updates only with a strictly newer row', () => {
		expect(applyEvent(items, { action: 'update', record: rec('a', '2026-11-11 08:00:00.200Z', 'new') })[0].note).toBe('new');
		expect(applyEvent(items, { action: 'update', record: rec('a', '2026-11-11 08:00:00.100Z', 'echo') })).toBe(items);
		expect(applyEvent(items, { action: 'update', record: rec('a', '2026-11-11 08:00:00.050Z', 'late') })).toBe(items);
	});

	it('removes on delete; a delete of an unknown row changes nothing', () => {
		expect(applyEvent(items, { action: 'delete', record: rec('a', '') })).toEqual([]);
		expect(applyEvent(items, { action: 'delete', record: rec('zz', '') })).toBe(items);
	});
});

describe('subscribeLive (real server)', () => {
	it("delivers own changes from another client, never another user's", async () => {
		const url = inject('pbUrl');
		const admin = createClient(url);
		await admin.collection('_superusers').authWithPassword('admin@test.local', 'admin-password-1');
		await admin.settings.update({ rateLimits: { enabled: false } });
		const code = `R${crypto.randomUUID().slice(0, 8)}`;
		await admin.collection('invites').create({ code, uses_left: 5 });
		const email = `r${crypto.randomUUID().slice(0, 8)}@example.com`;
		const viewer = createClient(url);
		await signUp(viewer, email, 'password123', code);
		const writer = createClient(url);
		await writer.collection('users').authWithPassword(email, 'password123');
		const other: PocketBase = createClient(url);
		await signUp(other, `o${crypto.randomUUID().slice(0, 8)}@example.com`, 'password123', code);

		const seen: string[] = [];
		let projects = 0;
		const off = await subscribeLive(viewer, { inspiration: (e) => seen.push(`${e.action}:${e.record.note}`), project: () => projects++ });
		const png = new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')], { type: 'image/png' });
		const uid = writer.authStore.record!.id;
		const { id } = await createInspiration(writer, uid, png, { note: 'one' });
		await updateInspiration(writer, id, { note: 'two' });
		await createInspiration(other, other.authStore.record!.id, png, { note: 'secret' });
		await writer.collection('projects').create({ user_id: uid, name: 'Live' });
		await deleteInspiration(writer, id);
		await expect.poll(() => seen.length, { timeout: 5000 }).toBe(3);
		expect(seen).toEqual(['create:one', 'update:two', 'delete:two']);
		expect(projects).toBe(1);
		await off();
	});
});
