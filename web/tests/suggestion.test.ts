// AI suggestions (level + tags written by the MCP tool suggest_labels): parsing, accept, dismiss.
import { beforeAll, describe, expect, inject, it } from 'vitest';
import type PocketBase from 'pocketbase';
import { createClient } from '../src/lib/pb';
import { listLevels } from '../src/lib/levels';
import { acceptSuggestion, createInspiration, signUp, toInspiration, updateInspiration } from '../src/lib/inspirations';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

describe('acceptSuggestion', () => {
	it('sets the suggested level and adds the tags without losing the user’s own', () => {
		expect(acceptSuggestion({ level: null, tags: ['φως'] }, { level: 'lv-building', tags: ['ξύλο', 'φως'] })).toEqual({
			level: 'lv-building',
			tags: ['φως', 'ξύλο']
		});
	});
	it('keeps the current level when the suggestion has none', () => {
		expect(acceptSuggestion({ level: 'lv-detail', tags: [] }, { level: null, tags: ['ξύλο'] })).toEqual({ level: 'lv-detail', tags: ['ξύλο'] });
	});
});

describe('toInspiration suggestion', () => {
	const base = { id: 'x', created_at: '', updated_at: '' } as never;
	it('is null when empty or malformed', () => {
		expect(toInspiration({ ...(base as object), suggestion: null } as never).suggestion).toBeNull();
		expect(toInspiration({ ...(base as object), suggestion: {} } as never).suggestion).toBeNull();
		expect(toInspiration({ ...(base as object), suggestion: { level: 7, tags: 'x' } } as never).suggestion).toBeNull();
	});
	it('keeps a level id and string tags', () => {
		expect(toInspiration({ ...(base as object), suggestion: { level: 'lv-urban', tags: ['α', 3] } } as never).suggestion).toEqual({
			level: 'lv-urban',
			tags: ['α']
		});
	});
});

describe('dismiss / accept round trip', () => {
	let pb: PocketBase;
	let uid = '';
	beforeAll(async () => {
		const admin = createClient(inject('pbUrl'));
		await admin.collection('_superusers').authWithPassword('admin@test.local', 'admin-password-1');
		await admin.settings.update({ rateLimits: { enabled: false } });
		const code = `S${crypto.randomUUID().slice(0, 8)}`;
		await admin.collection('invites').create({ code, uses_left: 1 });
		pb = createClient(inject('pbUrl'));
		await signUp(pb, `s${crypto.randomUUID().slice(0, 8)}@example.com`, 'password123', code);
		uid = pb.authStore.record!.id;
	});

	it('stores level/tags and clears the suggestion in one update', async () => {
		const { id } = await createInspiration(pb, uid, new Blob([PNG], { type: 'image/png' }), { tags: ['φως'] });
		const interior = (await listLevels(pb)).find((l) => l.name === 'Εσωτερικό')!.id;
		await pb.collection('inspirations').update(id, { suggestion: { level: interior, tags: ['ξύλο'] } });
		const shown = toInspiration(await pb.collection('inspirations').getOne(id));
		expect(shown.suggestion).toEqual({ level: interior, tags: ['ξύλο'] });
		const row = await updateInspiration(pb, id, { ...acceptSuggestion(shown, shown.suggestion!), suggestion: null });
		expect(row).toMatchObject({ level: interior, tags: ['φως', 'ξύλο'], suggestion: null });
	});
});
