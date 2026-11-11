// Client-side data helpers (browser and tests). The PocketBase client acts as the signed-in user, so
// the collection API rules and the server hooks limit every call to the user's own rows and files.
import type PocketBase from 'pocketbase';
import type { RecordModel } from 'pocketbase';
import type { Inspiration, Project } from '#lib/types.js';

export const IMAGE_EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/avif': 'avif'
};
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type NewFields = Partial<
	Pick<Inspiration, 'project_id' | 'note' | 'tags' | 'level' | 'regions' | 'source_url' | 'source_title'>
>;

/** Trim, lowercase and dedupe tags; keep at most 30. */
export function cleanTags(tags: string[] = []): string[] {
	return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
}

/** Throws a user-readable (Greek) message when the file cannot be stored. */
export function checkImage(file: Blob): string {
	const ext = IMAGE_EXT[file.type];
	if (!ext) throw new Error('Μη υποστηριζόμενος τύπος εικόνας (type): png, jpeg, webp, gif ή avif.');
	if (file.size > MAX_IMAGE_BYTES) throw new Error('Η εικόνα είναι μεγαλύτερη από 10MB.');
	return ext;
}

function msg(e: unknown): string {
	const r = e as { response?: { message?: string; data?: Record<string, { message?: string }> }; message?: string };
	const field = r.response?.data && Object.entries(r.response.data)[0];
	if (field) return `${field[0]}: ${field[1]?.message ?? ''}`.trim();
	return r.response?.message || r.message || 'άγνωστο σφάλμα';
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
		note: r.note ?? '',
		tags: Array.isArray(r.tags) ? r.tags : [],
		level: r.level || null,
		regions: Array.isArray(r.regions) ? r.regions : [],
		created_at: r.created_at,
		updated_at: r.updated_at
	};
}

export function toProject(r: RecordModel): Project {
	return { id: r.id, name: r.name, description: r.description ?? '', created_at: r.created_at };
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
		throw new Error(`Αποτυχία δημιουργίας project: ${msg(e)}`);
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

/** Image URL per `image_path`, with one file token (valid 1 hour) for all of them. */
export async function imageUrls(pb: PocketBase, rows: Inspiration[]): Promise<Record<string, string>> {
	if (!rows.length) return {};
	const token = await pb.files.getToken();
	const out: Record<string, string> = {};
	for (const r of rows) {
		if (r.image_path) out[r.image_path] = imageUrl(pb, r, token);
	}
	return out;
}

export function imageUrl(pb: PocketBase, r: Pick<Inspiration, 'id' | 'image_path'>, token: string): string {
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

/** Upload the image and create the row in one request. */
export async function createInspiration(
	pb: PocketBase,
	userId: string,
	file: Blob,
	fields: NewFields
): Promise<{ id: string }> {
	checkImage(file);
	try {
		const rec = await pb.collection('inspirations').create(
			form({ ...fields, user_id: userId, note: (fields.note ?? '').trim(), tags: cleanTags(fields.tags), regions: fields.regions ?? [] }, file)
		);
		return { id: rec.id };
	} catch (e) {
		throw new Error(`Αποτυχία αποθήκευσης: ${msg(e)}`);
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
		throw new Error(`Αποτυχία αντιγραφής: ${msg(e)}`);
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

export type EditableFields = Partial<Pick<Inspiration, 'note' | 'tags' | 'level' | 'regions' | 'project_id'>>;

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
		if ((e as { status?: number }).status === 404) throw new Error('Η εικόνα δεν βρέθηκε.');
		throw new Error(`Αποτυχία αποθήκευσης: ${msg(e)}`);
	}
}

/** Delete the row; PocketBase removes its image file. Throws when it is not the caller's. */
export async function deleteInspiration(pb: PocketBase, id: string): Promise<void> {
	try {
		await pb.collection('inspirations').delete(id);
	} catch (e) {
		if ((e as { status?: number }).status === 404) throw new Error('Η εικόνα δεν βρέθηκε.');
		throw new Error(`Αποτυχία διαγραφής: ${msg(e)}`);
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
