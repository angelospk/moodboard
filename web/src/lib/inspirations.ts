// Client-side data helpers (browser and tests). The PocketBase client acts as the signed-in user, so
// the collection API rules and the server hooks limit every call to the user's own rows and files.
import type PocketBase from 'pocketbase';
import { compressImage } from '#lib/compress.js';
import { t } from '#lib/i18n.js';
import type { RecordModel } from 'pocketbase';
import type { Crop, Inspiration, Project, Suggestion } from '#lib/types.js';

const PROD_API = 'https://moodboard-api.haroldpoi.dev';
/** Host of the image bucket (Cloudflare R2). VITE_IMAGE_CDN overrides it; '' turns it off. */
export const IMAGE_CDN: string = import.meta.env.VITE_IMAGE_CDN ?? 'https://images.haroldpoi.dev';

/** The image host for a client: the CDN only for the production API. Any other backend (local
 *  server, tests) serves its own files. */
export function cdnFor(pb: Pick<PocketBase, 'baseURL'>): string {
	return pb.baseURL === PROD_API ? IMAGE_CDN : '';
}

export const IMAGE_EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/avif': 'avif'
};
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type NewFields = Partial<
	Pick<Inspiration, 'project_id' | 'note' | 'tags' | 'level' | 'regions' | 'source_url' | 'source_title' | 'image_url' | 'crop'>
>;

/** Trim, lowercase and dedupe tags; keep at most 30. */
export function cleanTags(tags: string[] = []): string[] {
	return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
}

/** Throws a user-readable (Greek) message when the file cannot be stored. With `beforeCompress`, the
 *  size of a file that compressImage can shrink (not a GIF) is not checked: the limit applies to
 *  the bytes uploaded, and createInspiration checks them. */
export function checkImage(file: Blob, beforeCompress = false): string {
	const ext = IMAGE_EXT[file.type];
	if (!ext) throw new Error(t('err.imageType'));
	if (file.size > MAX_IMAGE_BYTES && !(beforeCompress && file.type !== 'image/gif')) throw new Error(t('err.imageSize'));
	return ext;
}

export function msg(e: unknown): string {
	const r = e as { response?: { message?: string; data?: Record<string, { message?: string }> }; message?: string };
	const field = r.response?.data && Object.entries(r.response.data)[0];
	if (field) return `${field[0]}: ${field[1]?.message ?? ''}`.trim();
	return r.response?.message || r.message || t('common.unknownError');
}

/** A PocketBase inspirations record in the app's shape. `image_path` is the stored file name: it is
 *  unique per image, so it keys image URLs (see imageUrls). Empty relation/select values become null. */
export function toInspiration(r: RecordModel): Inspiration {
	return {
		id: r.id,
		project_id: r.project_id || null,
		image_path: r.image ?? '',
		source_url: r.source_url || null,
		source_title: r.source_title || null,
		image_url: r.image_url || null,
		crop: toCrop(r.crop),
		note: r.note ?? '',
		tags: Array.isArray(r.tags) ? r.tags : [],
		level: r.level || null,
		regions: Array.isArray(r.regions) ? r.regions : [],
		suggestion: toSuggestion(r.suggestion),
		created_at: r.created_at,
		updated_at: r.updated_at
	};
}

function toSuggestion(v: unknown): Suggestion | null {
	const s = v as Partial<Suggestion> | null;
	if (!s || typeof s !== 'object' || (s.level != null && typeof s.level !== 'string')) return null;
	const tags = Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === 'string') : [];
	return s.level || tags.length ? { level: s.level || null, tags } : null;
}

/** The level and tags after accepting a suggestion: its level (if any) and the union of the tags. */
export function acceptSuggestion(cur: Pick<Inspiration, 'level' | 'tags'>, s: Suggestion): Pick<Inspiration, 'level' | 'tags'> {
	return { level: s.level ?? cur.level, tags: cleanTags([...cur.tags, ...s.tags]) };
}

function toCrop(v: unknown): Crop | null {
	const c = v as Partial<Crop> | null;
	return c && typeof c === 'object' && [c.x, c.y, c.w, c.h].every((n) => typeof n === 'number')
		? { x: c.x!, y: c.y!, w: c.w!, h: c.h! }
		: null;
}

export function toProject(r: RecordModel): Project {
	return { id: r.id, name: r.name, description: r.description ?? '', archived: !!r.archived, created_at: r.created_at };
}

/** The user's projects, by name. */
export async function listProjects(pb: PocketBase): Promise<Project[]> {
	const rows = await pb.collection('projects').getFullList({ sort: 'name,id' });
	return rows.map(toProject);
}

/** Create a project for the signed-in user. */
export async function createProject(pb: PocketBase, userId: string, name: string, description = ''): Promise<Project> {
	try {
		return toProject(await pb.collection('projects').create({ user_id: userId, name: name.trim(), description }));
	} catch (e) {
		throw new Error(t('err.createProject', { msg: msg(e) }));
	}
}

/** Rename a project. A name another project already has is refused. */
export async function renameProject(pb: PocketBase, id: string, name: string): Promise<Project> {
	try {
		return toProject(await pb.collection('projects').update(id, { name: name.trim() }));
	} catch (e) {
		throw new Error(t('err.renameProject', { msg: msg(e) }));
	}
}

/** Put a project in the archive, or bring it back. Its images stay. */
export async function setProjectArchived(pb: PocketBase, id: string, archived: boolean): Promise<Project> {
	try {
		return toProject(await pb.collection('projects').update(id, { archived }));
	} catch (e) {
		throw new Error(t('err.archiveProject', { msg: msg(e) }));
	}
}

/** Delete a project. Its images stay, without a project. */
export async function deleteProject(pb: PocketBase, id: string): Promise<void> {
	try {
		await pb.collection('projects').delete(id);
	} catch (e) {
		throw new Error(t('err.deleteProject', { msg: msg(e) }));
	}
}

/** All of the user's inspirations, newest first. */
export async function listInspirations(pb: PocketBase): Promise<Inspiration[]> {
	const rows = await pb.collection('inspirations').getFullList({ sort: '-created_at,id' });
	return rows.map(toInspiration);
}

/** One inspiration, or null when it does not exist or is not the user's. */
export async function getInspiration(pb: PocketBase, id: string): Promise<Inspiration | null> {
	try {
		return toInspiration(await pb.collection('inspirations').getOne(id));
	} catch (e) {
		if ((e as { status?: number }).status === 404) return null;
		throw new Error(msg(e));
	}
}

// File tokens last 7 days (server setting). One token per user and server, reused until a day
// before it ends: image URLs then stay the same across visits, and the browser serves them from
// its cache (PocketBase sends max-age=30 days). Kept in localStorage (shared by all tabs, so a
// sign-in in one tab renews it for all); in memory only when storage is unavailable.
const DAY = 24 * 3600_000;
const tokens = new Map<string, { token: string; exp: number }>();
const pending = new Map<string, Promise<string>>();

function tokenKey(pb: PocketBase): string {
	return `mb_file_token:${pb.baseURL}:${pb.authStore.record?.id ?? ''}`;
}

function jwtExp(token: string): number {
	try {
		const body = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
		return Number(JSON.parse(atob(body)).exp) * 1000 || 0;
	} catch {
		return 0;
	}
}

function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/** A file token for the signed-in user, from the cache when it still has more than a day left. */
export async function fileToken(pb: PocketBase): Promise<string> {
	const key = tokenKey(pb);
	const fresh = (v: { token: string; exp: number } | null | undefined) => !!v && v.exp - Date.now() > DAY;
	// localStorage first: it is shared by all tabs, so a token renewed in one (e.g. after a new
	// sign-in) reaches the others. Memory only when storage is unavailable.
	const store = storage();
	let hit: { token: string; exp: number } | undefined;
	if (store) {
		try {
			hit = JSON.parse(store.getItem(key) ?? 'null') ?? undefined;
		} catch {
			hit = undefined;
		}
	} else hit = tokens.get(key);
	if (fresh(hit)) {
		tokens.set(key, hit!);
		return hit!.token;
	}
	let p = pending.get(key);
	if (!p) {
		p = pb.files
			.getToken()
			.then((token) => {
				const v = { token, exp: jwtExp(token) };
				tokens.set(key, v);
				try {
					storage()?.setItem(key, JSON.stringify(v));
				} catch {
					/* private mode: memory only */
				}
				return token;
			})
			.finally(() => pending.delete(key));
		pending.set(key, p);
	}
	return p;
}

/** Drop the cached file token of the signed-in user (after a sign-in: the old one may be invalid). */
export function forgetFileToken(pb: PocketBase) {
	const key = tokenKey(pb);
	tokens.delete(key);
	try {
		storage()?.removeItem(key);
	} catch {
		/* ignore */
	}
}

/** Image URL per `image_path`, all with the same cached file token. */
export async function imageUrls(pb: PocketBase, rows: Inspiration[]): Promise<Record<string, string>> {
	if (!rows.length) return {};
	const cdn = cdnFor(pb);
	// CDN urls carry no token, so a failed token request cannot hide the images.
	const token = cdn ? '' : await fileToken(pb);
	const out: Record<string, string> = {};
	for (const r of rows) {
		if (r.image_path) out[r.image_path] = imageUrl(pb, r, token, cdn);
	}
	return out;
}

/** The 480px-wide thumbnail of a server image URL; other URLs (local blob: previews) stay as they are. */
export function thumbUrl(url: string | null | undefined, cdn = IMAGE_CDN): string | null {
	if (!url) return null;
	if (!/^https?:/.test(url)) return url;
	if (cdn && url.startsWith(`${cdn}/`)) {
		// The server stores the thumbnail next to the image: thumbs_<name>/480x0_<name>.
		const cut = url.lastIndexOf('/');
		const name = url.slice(cut + 1);
		return `${url.slice(0, cut)}/thumbs_${name}/480x0_${name}`;
	}
	const u = new URL(url);
	u.searchParams.set('thumb', '480x0');
	return u.toString();
}

export function imageUrl(pb: PocketBase, r: Pick<Inspiration, 'id' | 'image_path'>, token: string, cdn = cdnFor(pb)): string {
	// The CDN (Cloudflare R2) serves the file by its unguessable path: no token, no API call.
	if (cdn) return `${cdn}/mbinspirations/${r.id}/${encodeURIComponent(r.image_path)}`;
	return pb.files.getURL({ id: r.id, collectionName: 'inspirations' }, r.image_path, { token });
}

function form(fields: Record<string, unknown>, file?: Blob): FormData {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) {
		if (v === undefined) continue;
		fd.append(k, v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
	}
	if (file) fd.append('image', file, `image.${IMAGE_EXT[file.type]}`);
	return fd;
}

/** A new record id, made in the browser (PocketBase's format: 15 chars a-z0-9). With it a card can
 *  show before its upload ends, under the id it will keep. */
export function newId(): string {
	const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
	const bytes = crypto.getRandomValues(new Uint8Array(15));
	return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

/** Upload the image and create the row in one request; returns the stored row. */
export async function createInspiration(
	pb: PocketBase,
	userId: string,
	file: Blob,
	fields: NewFields & { id?: string }
): Promise<Inspiration> {
	const small = await compressImage(file);
	checkImage(small);
	try {
		const rec = await pb.collection('inspirations').create(
			form({ ...fields, user_id: userId, note: (fields.note ?? '').trim(), tags: cleanTags(fields.tags), regions: fields.regions ?? [] }, small)
		);
		return toInspiration(rec);
	} catch (e) {
		throw new Error(t('err.save', { msg: msg(e) }));
	}
}

/** Duplicate an inspiration (image file too) into `projectId`. The original stays as it is. */
export async function copyInspiration(
	pb: PocketBase,
	_userId: string,
	id: string,
	projectId: string | null
): Promise<{ id: string }> {
	try {
		return await pb.send<{ id: string }>(`/api/mb/inspirations/${encodeURIComponent(id)}/copy`, {
			method: 'POST',
			body: { project_id: projectId }
		});
	} catch (e) {
		throw new Error(t('err.copy', { msg: msg(e) }));
	}
}

/** The user's past tags, most used first (for one-click chips). */
export async function userTags(pb: PocketBase): Promise<string[]> {
	return pb.send<string[]>('/api/mb/tags', { method: 'GET' });
}

export interface NodePosition {
	/** 'i:<inspiration id>', 't:<tag>' or 'p:<project id>'. */
	key: string;
	x: number;
	y: number;
}

/** Store where the user placed nodes on one map. scope = project id, 'all' or 'none'. */
export async function savePositions(pb: PocketBase, scope: string, positions: NodePosition[]) {
	const rows = positions.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
	if (!rows.length) return;
	try {
		await pb.send('/api/mb/positions', { method: 'POST', body: { scope, positions: rows } });
	} catch (e) {
		throw new Error(msg(e));
	}
}

/** Forget nodes' saved positions: in one scope, or in every scope when scope is null. */
export async function deletePosition(pb: PocketBase, scope: string | null, key: string | string[]) {
	const keys = Array.isArray(key) ? key : [key];
	if (!keys.length) return;
	try {
		await pb.send('/api/mb/positions/delete', { method: 'POST', body: { scope: scope ?? '', keys } });
	} catch (e) {
		throw new Error(msg(e));
	}
}

/** Saved node positions of one map, by node key. */
export async function loadPositions(pb: PocketBase, scope: string): Promise<Record<string, { x: number; y: number }>> {
	const rows = await pb.collection('map_positions').getFullList({ filter: pb.filter('scope = {:s}', { s: scope }) });
	const out: Record<string, { x: number; y: number }> = {};
	for (const r of rows) out[r.node_key] = { x: r.x, y: r.y };
	return out;
}

export type EditableFields = Partial<Pick<Inspiration, 'note' | 'tags' | 'level' | 'regions' | 'project_id' | 'crop' | 'suggestion'>>;

/** Save edits to one inspiration and return the updated row. Throws when it is not the caller's. */
export async function updateInspiration(pb: PocketBase, id: string, fields: EditableFields): Promise<Inspiration> {
	const patch: Record<string, unknown> = { ...fields };
	if (fields.note !== undefined) patch.note = fields.note.trim();
	if (fields.tags !== undefined) patch.tags = cleanTags(fields.tags);
	if (fields.project_id !== undefined) patch.project_id = fields.project_id ?? '';
	if (fields.level !== undefined) patch.level = fields.level ?? '';
	try {
		return toInspiration(await pb.collection('inspirations').update(id, patch));
	} catch (e) {
		if ((e as { status?: number }).status === 404) throw new Error(t('err.imageNotFound'));
		throw new Error(t('err.save', { msg: msg(e) }));
	}
}

/** Delete the row; PocketBase removes its image file. Throws when it is not the caller's. */
export async function deleteInspiration(pb: PocketBase, id: string): Promise<void> {
	try {
		await pb.collection('inspirations').delete(id);
	} catch (e) {
		if ((e as { status?: number }).status === 404) throw new Error(t('err.imageNotFound'));
		throw new Error(t('err.delete', { msg: msg(e) }));
	}
}

/** Append text to an inspiration's note on the server (atomic). */
export async function appendNote(pb: PocketBase, id: string, text: string): Promise<{ id: string; note: string }> {
	return pb.send(`/api/mb/inspirations/${encodeURIComponent(id)}/note`, { method: 'POST', body: { text } });
}

/** Sign up with an invite code, then sign in. */
export async function signUp(pb: PocketBase, email: string, password: string, invite: string) {
	try {
		await pb.collection('users').create({ email, password, passwordConfirm: password, invite: invite.trim() });
	} catch (e) {
		throw new Error(msg(e));
	}
	await pb.collection('users').authWithPassword(email, password);
}

/** Should a realtime row replace the shown one? Only when it is strictly newer, so a late echo of
 *  an older save never overwrites a newer local state. */
export function isNewer(incoming: Pick<Inspiration, 'updated_at'>, shown: Pick<Inspiration, 'updated_at'> | undefined) {
	return !shown || incoming.updated_at > shown.updated_at;
}
