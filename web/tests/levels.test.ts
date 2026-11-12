// The user's own levels (collection "levels"), against a real PocketBase (tests/pb-server.ts).
import type PocketBase from 'pocketbase';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { createClient } from '../src/lib/pb';
import { createInspiration, getInspiration, signUp } from '../src/lib/inspirations';
import { addLevel, deleteLevel, levelName, listLevels, moveLevel, renameLevel } from '../src/lib/levels';

const URL_ = inject('pbUrl');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const png = () => new Blob([PNG], { type: 'image/png' });

let invite = '';
async function newUser(): Promise<{ pb: PocketBase; id: string }> {
	const pb = createClient(URL_);
	await signUp(pb, `l${crypto.randomUUID().slice(0, 8)}@example.com`, 'password123', invite);
	return { pb, id: pb.authStore.record!.id };
}

let A: { pb: PocketBase; id: string };
let B: { pb: PocketBase; id: string };

beforeAll(async () => {
	const admin = createClient(URL_);
	await admin.collection('_superusers').authWithPassword('admin@test.local', 'admin-password-1');
	await admin.settings.update({ rateLimits: { enabled: false } });
	invite = `L${crypto.randomUUID().slice(0, 8)}`;
	await admin.collection('invites').create({ code: invite, uses_left: 10 });
	A = await newUser();
	B = await newUser();
});

describe('levels', () => {
	it('start as five defaults, in order', async () => {
		const rows = await listLevels(A.pb);
		expect(rows.map((r) => r.name)).toEqual(['Αστικό', 'Κτίριο', 'Εσωτερικό', 'Λεπτομέρεια', 'Υλικό']);
		expect(levelName(rows, rows[3].id)).toBe('Λεπτομέρεια');
		expect(levelName(rows, null)).toBe('');
		expect(levelName(rows, 'gone')).toBe('');
	});

	it('add, rename and reject duplicates and empty names', async () => {
		const row = await addLevel(A.pb, A.id, '  Κήπος ');
		expect(row.name).toBe('Κήπος');
		const rows = await listLevels(A.pb);
		expect(rows[rows.length - 1].id).toBe(row.id);
		await expect(addLevel(A.pb, A.id, 'κήπος')).rejects.toThrow(/ήδη/);
		await expect(addLevel(A.pb, A.id, '   ')).rejects.toThrow();
		expect((await renameLevel(A.pb, row.id, 'Βεράντα')).name).toBe('Βεράντα');
		await expect(renameLevel(A.pb, row.id, 'Υλικό')).rejects.toThrow(/ήδη/);
	});

	it('are private to their owner', async () => {
		const mine = await listLevels(A.pb);
		expect((await listLevels(B.pb)).map((r) => r.id)).not.toContain(mine[0].id);
		await expect(renameLevel(B.pb, mine[0].id, 'x')).rejects.toThrow();
		await expect(deleteLevel(B.pb, mine[0].id)).rejects.toThrow();
		const bobs = await listLevels(B.pb);
		await expect(createInspiration(A.pb, A.id, png(), { level: bobs[0].id })).rejects.toThrow();
	});

	it('move up and down, and keep the order saved', async () => {
		const rows = await listLevels(A.pb);
		const [first, second] = rows;
		const moved = await moveLevel(A.pb, rows, second.id, -1);
		expect(moved.slice(0, 2).map((r) => r.id)).toEqual([second.id, first.id]);
		expect((await listLevels(A.pb)).slice(0, 2).map((r) => r.id)).toEqual([second.id, first.id]);
		// The first row cannot go further up: nothing changes.
		expect((await moveLevel(A.pb, moved, moved[0].id, -1)).map((r) => r.id)).toEqual(moved.map((r) => r.id));
		const last = moved[moved.length - 1];
		expect((await moveLevel(A.pb, moved, last.id, 1)).map((r) => r.id)).toEqual(moved.map((r) => r.id));
	});

	it('delete clears the level on images and keeps them', async () => {
		const row = await addLevel(A.pb, A.id, 'Προσωρινό');
		const { id } = await createInspiration(A.pb, A.id, png(), { level: row.id });
		expect(await getInspiration(A.pb, id)).toMatchObject({ level: row.id });
		await deleteLevel(A.pb, row.id);
		expect(await getInspiration(A.pb, id)).toMatchObject({ level: null });
		expect((await listLevels(A.pb)).map((r) => r.id)).not.toContain(row.id);
	});
});
