// suggestLabels asks the server about an unsaved image; it must never throw and never fill the form
// when AI is off. A fake client stands in for PocketBase.
import type PocketBase from 'pocketbase';
import { describe, expect, it } from 'vitest';
import { setAiEnabled, suggestLabels } from '../src/lib/suggest';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const file = () => new File([PNG], 'a.png', { type: 'image/png' });

function fakePb(send: (path: string, opts: { method?: string; body?: FormData; requestKey?: string | null }) => Promise<unknown>) {
	return { send } as unknown as PocketBase;
}

describe('suggestLabels', () => {
	it('posts the image to /api/mb/suggest and returns level and tags', async () => {
		let seen: { path: string; body?: FormData; method?: string; requestKey?: string | null } | null = null;
		const pb = fakePb(async (path, opts) => {
			seen = { path, ...opts };
			return { enabled: true, level: 'lv1', tags: ['ξύλο', 'φως'] };
		});
		expect(await suggestLabels(pb, file())).toEqual({ level: 'lv1', tags: ['ξύλο', 'φως'] });
		expect(seen!.path).toBe('/api/mb/suggest');
		expect(seen!.method).toBe('POST');
		expect(seen!.requestKey).toBeNull(); // never cancelled by another request
		expect(seen!.body!.get('image')).toBeInstanceOf(Blob);
	});

	it('returns null when AI is off', async () => {
		expect(await suggestLabels(fakePb(async () => ({ enabled: false })), file())).toBeNull();
	});

	it('returns null on any failure (limit, model down, offline)', async () => {
		expect(await suggestLabels(fakePb(async () => { throw new Error('429'); }), file())).toBeNull();
	});

	it('tolerates a missing level or tags in the answer', async () => {
		expect(await suggestLabels(fakePb(async () => ({ enabled: true })), file())).toEqual({ level: '', tags: [] });
	});

	it('does not call the server for a file that is not an image', async () => {
		let calls = 0;
		const pb = fakePb(async () => { calls++; return { enabled: true }; });
		expect(await suggestLabels(pb, new File(['x'], 'a.txt', { type: 'text/plain' }))).toBeNull();
		expect(calls).toBe(0);
	});
});

describe('setAiEnabled', () => {
	it('updates only the ai_enabled field of the user', async () => {
		const calls: unknown[][] = [];
		const pb = {
			collection: (name: string) => ({ update: async (...a: unknown[]) => void calls.push([name, ...a]) })
		} as unknown as PocketBase;
		await setAiEnabled(pb, 'u1', true);
		await setAiEnabled(pb, 'u1', false);
		expect(calls).toEqual([
			['users', 'u1', { ai_enabled: true }],
			['users', 'u1', { ai_enabled: false }]
		]);
	});
});
