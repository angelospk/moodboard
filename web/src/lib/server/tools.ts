// Moodboard operations shared by the MCP server. Every function takes a Supabase client that is
// authenticated AS THE USER, so Postgres RLS enforces ownership; nothing here uses a service key.
import type { SupabaseClient } from '@supabase/supabase-js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BUCKET, LEVELS, type Inspiration, type Level, type Project } from '#lib/types.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/avif': 'avif'
};

function fail(msg: string, err?: { message: string } | null): never {
	throw new Error(err ? `${msg}: ${err.message}` : msg);
}

export async function listProjects(sb: SupabaseClient) {
	const { data, error } = await sb
		.from('projects')
		.select('id, name, description, created_at, inspirations(count)')
		.order('created_at', { ascending: false });
	if (error) fail('list projects failed', error);
	return data.map(({ inspirations, ...p }) => ({
		...(p as Project),
		inspiration_count: (inspirations as unknown as { count: number }[])[0]?.count ?? 0
	}));
}

/** Find a project by id or (case-insensitive) name. Optionally create it when missing. */
export async function resolveProject(sb: SupabaseClient, ref: string, create = false) {
	const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
	const q = sb.from('projects').select('id, name');
	const { data, error } = await (isUuid ? q.eq('id', ref) : q.ilike('name', escapeLike(ref.trim())));
	if (error) fail('project lookup failed', error);
	if (data.length) return data[0] as { id: string; name: string };
	if (!create || isUuid) fail(`project not found: ${ref}`);
	const ins = await sb.from('projects').insert({ name: ref.trim() }).select('id, name').single();
	if (ins.error) fail('create project failed', ins.error);
	return ins.data as { id: string; name: string };
}

function escapeLike(s: string) {
	return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface SearchArgs {
	query?: string;
	project?: string;
	tags?: string[];
	level?: Level;
	limit?: number;
}

export async function searchInspirations(sb: SupabaseClient, args: SearchArgs) {
	let q = sb
		.from('inspirations')
		.select('id, project_id, note, tags, level, regions, source_url, source_title, created_at, projects(name)')
		.order('created_at', { ascending: false })
		.limit(Math.min(Math.max(args.limit ?? 20, 1), 100));
	if (args.project) q = q.eq('project_id', (await resolveProject(sb, args.project)).id);
	if (args.level) q = q.eq('level', args.level);
	if (args.tags?.length) q = q.contains('tags', args.tags.map((t) => t.toLowerCase()));
	const text = args.query?.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim();
	if (text) {
		// PostgREST or-filter: the text is reduced to letters/digits/space above, so it cannot inject syntax.
		const pat = `%${text}%`;
		q = q.or(`note.ilike.${pat},source_title.ilike.${pat}`);
	}
	const { data, error } = await q;
	if (error) fail('search failed', error);
	return data;
}

export async function getInspiration(sb: SupabaseClient, id: string) {
	const { data, error } = await sb
		.from('inspirations')
		.select('*, projects(name)')
		.eq('id', id)
		.maybeSingle();
	if (error) fail('get failed', error);
	if (!data) fail(`inspiration not found: ${id}`);
	const row = data as Inspiration & { projects: { name: string } | null };
	const signed = await sb.storage.from(BUCKET).createSignedUrl(row.image_path, 3600);
	let image: { data: string; mimeType: string } | null = null;
	const file = await sb.storage.from(BUCKET).download(row.image_path);
	if (!file.error && file.data.size <= INLINE_IMAGE_BYTES) {
		image = {
			data: Buffer.from(await file.data.arrayBuffer()).toString('base64'),
			mimeType: file.data.type || 'image/png'
		};
	}
	return { inspiration: row, image_url: signed.data?.signedUrl ?? null, image };
}

export interface SaveArgs {
	image_url: string;
	project?: string;
	note?: string;
	tags?: string[];
	level?: Level;
	source_url?: string;
	source_title?: string;
}

export async function saveInspiration(
	sb: SupabaseClient,
	userId: string,
	args: SaveArgs,
	fetchImage: (url: string) => Promise<{ bytes: Uint8Array; type: string }> = safeFetchImage
) {
	if (args.level && !LEVELS.includes(args.level)) fail(`invalid level: ${args.level}`);
	const project = args.project ? await resolveProject(sb, args.project, true) : null;
	const { bytes, type } = await fetchImage(args.image_url);
	return insertInspiration(sb, userId, bytes, type, {
		project_id: project?.id ?? null,
		note: args.note ?? '',
		tags: normTags(args.tags),
		level: args.level ?? null,
		source_url: args.source_url ?? args.image_url,
		source_title: args.source_title ?? null
	});
}

export async function insertInspiration(
	sb: SupabaseClient,
	userId: string,
	bytes: Uint8Array,
	type: string,
	fields: Partial<Inspiration>
) {
	const ext = EXT[type];
	if (!ext) fail(`unsupported image type: ${type}`);
	const path = `${userId}/${crypto.randomUUID()}.${ext}`;
	const up = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: type });
	if (up.error) fail('upload failed', up.error);
	const { data, error } = await sb
		.from('inspirations')
		.insert({ ...fields, image_path: path })
		.select('id, project_id, note, tags, level, created_at')
		.single();
	if (error) {
		await sb.storage.from(BUCKET).remove([path]);
		fail('save failed', error);
	}
	return data;
}

export async function addNote(sb: SupabaseClient, id: string, text: string) {
	const cur = await sb.from('inspirations').select('note').eq('id', id).maybeSingle();
	if (cur.error) fail('get failed', cur.error);
	if (!cur.data) fail(`inspiration not found: ${id}`);
	const note = cur.data.note ? `${cur.data.note}\n\n${text.trim()}` : text.trim();
	const { data, error } = await sb
		.from('inspirations')
		.update({ note })
		.eq('id', id)
		.select('id, note')
		.single();
	if (error) fail('update failed', error);
	return data;
}

export function normTags(tags?: string[]) {
	return [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
}

// ---- SSRF guard for server-side image fetch ----

export function isPrivateAddress(ip: string): boolean {
	if (isIP(ip) === 4) {
		const [a, b] = ip.split('.').map(Number);
		return (
			a === 0 || a === 10 || a === 127 || a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168)
		);
	}
	const v6 = ip.toLowerCase();
	if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
	return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/** Fetch a public https image. Rejects private/loopback hosts, redirects, non-images and big files.
 *  Known gap: DNS can change between lookup and fetch (rebinding); fix before public launch. */
export async function safeFetchImage(raw: string) {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		fail('image_url is not a valid URL');
	}
	if (url.protocol !== 'https:') fail('image_url must use https');
	const host = url.hostname.replace(/^\[|\]$/g, '');
	const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
	if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) fail('image_url host is not public');
	const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
	if (!res.ok) fail(`image fetch failed: HTTP ${res.status}`);
	const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
	if (!EXT[type]) fail(`unsupported image type: ${type || 'unknown'}`);
	if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) fail('image too large');
	const bytes = new Uint8Array(await res.arrayBuffer());
	if (bytes.byteLength > MAX_IMAGE_BYTES) fail('image too large');
	return { bytes, type };
}
