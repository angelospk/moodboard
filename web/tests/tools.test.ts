// Integration tests against local Supabase (`npx supabase start` in ../). Real RLS, real storage.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	addNote, getInspiration, isPrivateAddress, listProjects, safeFetchImage, saveInspiration, searchInspirations
} from '../src/lib/server/tools';
import { buildMcpServer } from '../src/lib/server/mcp';

const URL_ = 'http://127.0.0.1:54421';
const KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
// 1x1 transparent PNG
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
const fakeFetch = async () => ({ bytes: PNG, type: 'image/png' });

async function newUser(): Promise<{ sb: SupabaseClient; id: string }> {
	const sb = createClient(URL_, KEY, { auth: { persistSession: false } });
	const email = `t${crypto.randomUUID().slice(0, 8)}@example.com`;
	const { data, error } = await sb.auth.signUp({ email, password: 'password123' });
	if (error || !data.user) throw error ?? new Error('no user');
	return { sb, id: data.user.id };
}

let A: { sb: SupabaseClient; id: string };
let B: { sb: SupabaseClient; id: string };
let savedId: string;

beforeAll(async () => {
	A = await newUser();
	B = await newUser();
	const r = await saveInspiration(A.sb, A.id, {
		image_url: 'https://example.com/a.png', project: 'Σπίτι Πάρου', note: 'ωραία πέργκολα από ξύλο',
		tags: [' Wood ', 'wood', 'Pergola'], level: 'detail'
	}, fakeFetch);
	savedId = r.id;
});

describe('owner flow', () => {
	it('creates the project on save and counts it', async () => {
		const ps = await listProjects(A.sb);
		expect(ps).toHaveLength(1);
		expect(ps[0]).toMatchObject({ name: 'Σπίτι Πάρου', inspiration_count: 1 });
	});

	it('normalizes tags and reuses the project case-insensitively', async () => {
		const r = await saveInspiration(A.sb, A.id, { image_url: 'https://x/b.png', project: 'σπίτι πάρου' }, fakeFetch);
		expect((await listProjects(A.sb))[0].inspiration_count).toBe(2);
		const first = await getInspiration(A.sb, savedId);
		expect(first.inspiration.tags).toEqual(['wood', 'pergola']);
		expect(r.project_id).toBe(first.inspiration.project_id);
	});

	it('searches by text, tag, level and project', async () => {
		expect((await searchInspirations(A.sb, { query: 'πέργκολα' })).map((x) => x.id)).toEqual([savedId]);
		expect(await searchInspirations(A.sb, { tags: ['WOOD'] })).toHaveLength(1);
		expect(await searchInspirations(A.sb, { level: 'material' })).toHaveLength(0);
		expect(await searchInspirations(A.sb, { project: 'Σπίτι Πάρου' })).toHaveLength(2);
	});

	it('survives filter-syntax characters in the query', async () => {
		expect(await searchInspirations(A.sb, { query: 'a,note.ilike.*),(x' })).toEqual([]);
	});

	it('returns the image inline and a signed url', async () => {
		const r = await getInspiration(A.sb, savedId);
		expect(r.image?.mimeType).toBe('image/png');
		expect(r.image_url).toMatch(/^http/);
	});

	it('appends notes without losing text', async () => {
		const r = await addNote(A.sb, savedId, 'και το φως');
		expect(r.note).toBe('ωραία πέργκολα από ξύλο\n\nκαι το φως');
	});
});

describe('isolation between users', () => {
	it('B sees no projects or inspirations of A', async () => {
		expect(await listProjects(B.sb)).toEqual([]);
		expect(await searchInspirations(B.sb, {})).toEqual([]);
		await expect(getInspiration(B.sb, savedId)).rejects.toThrow(/not found/);
		await expect(addNote(B.sb, savedId, 'x')).rejects.toThrow(/not found/);
	});

	it('B cannot attach to A project id or write into A storage folder', async () => {
		const pid = (await listProjects(A.sb))[0].id;
		await expect(saveInspiration(B.sb, B.id, { image_url: 'https://x/c.png', project: pid }, fakeFetch)).rejects.toThrow(/not found/);
		const up = await B.sb.storage.from('inspirations').upload(`${A.id}/evil.png`, PNG, { contentType: 'image/png' });
		expect(up.error).not.toBeNull();
		const ins = await B.sb.from('inspirations').insert({ image_path: `${A.id}/x.png` });
		expect(ins.error).not.toBeNull();
		const dl = await B.sb.storage.from('inspirations').list(A.id);
		expect(dl.data ?? []).toEqual([]);
	});
});

describe('image fetch guard', () => {
	it('flags private addresses', () => {
		for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0'])
			expect(isPrivateAddress(ip), ip).toBe(true);
		for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
	});

	it('rejects http, localhost and private IPs before fetching', async () => {
		await expect(safeFetchImage('http://example.com/a.png')).rejects.toThrow(/https/);
		await expect(safeFetchImage('https://localhost/a.png')).rejects.toThrow(/not public/);
		await expect(safeFetchImage('https://169.254.169.254/latest')).rejects.toThrow(/not public/);
		await expect(safeFetchImage('https://[::1]/a.png')).rejects.toThrow(/not public/);
	});
});

describe('MCP wiring', () => {
	it('lists the 5 tools and runs search through the protocol', async () => {
		const [ct, st] = InMemoryTransport.createLinkedPair();
		await buildMcpServer(A.sb, A.id).connect(st);
		const client = new Client({ name: 'test', version: '0' });
		await client.connect(ct);
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual(['add_note', 'get_inspiration', 'list_projects', 'save_inspiration', 'search_inspirations']);
		const res = await client.callTool({ name: 'search_inspirations', arguments: { tags: ['pergola'] } });
		const rows = JSON.parse((res.content as { text: string }[])[0].text);
		expect(rows.map((r: { id: string }) => r.id)).toEqual([savedId]);
		const got = await client.callTool({ name: 'get_inspiration', arguments: { id: savedId } });
		expect((got.content as { type: string }[]).map((c) => c.type)).toEqual(['text', 'image']);
	});
});

describe('MCP input validation', () => {
	it('rejects javascript: source_url', async () => {
		const [ct, st] = InMemoryTransport.createLinkedPair();
		await buildMcpServer(A.sb, A.id).connect(st);
		const client = new Client({ name: 'test', version: '0' });
		await client.connect(ct);
		const res = await client.callTool({
			name: 'save_inspiration',
			arguments: { image_url: 'https://example.com/a.png', source_url: 'javascript:alert(1)' }
		});
		expect(res.isError).toBe(true);
	});
});

describe('review fixes', () => {
	it('flags IPv4-mapped IPv6 in hex form (URL-normalized)', async () => {
		expect(new URL('https://[::ffff:127.0.0.1]/').hostname).toBe('[::ffff:7f00:1]');
		for (const ip of ['::ffff:7f00:1', '::ffff:a00:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:7f00:1']) expect(isPrivateAddress(ip), ip).toBe(true);
		expect(isPrivateAddress('::ffff:808:808')).toBe(false);
		await expect(safeFetchImage('https://[::ffff:127.0.0.1]/a.png')).rejects.toThrow(/not public/);
	});

	it('concurrent add_note keeps every append', async () => {
		const r = await saveInspiration(A.sb, A.id, { image_url: 'https://x/n.png', note: 'start' }, fakeFetch);
		await Promise.all(Array.from({ length: 8 }, (_, i) => addNote(A.sb, r.id, `n${i}`)));
		const { inspiration } = await getInspiration(A.sb, r.id);
		for (let i = 0; i < 8; i++) expect(inspiration.note).toContain(`n${i}`);
	});

	it('stops reading an image body over the size cap', async () => {
		const { readCapped } = await import('../src/lib/server/tools');
		const big = new Response(new ReadableStream({
			pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); }
		}));
		await expect(readCapped(big, 3 * 1024 * 1024)).rejects.toThrow(/too large/);
	});
});
