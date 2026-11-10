// Client-safe data helpers (browser and tests). The Supabase client acts as the signed-in user, so RLS
// and the storage policies limit every call to the user's own rows and folder.
import type { SupabaseClient } from '@supabase/supabase-js';
import { BUCKET, type Inspiration } from '#lib/types.js';

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

/** Upload the image and insert the row. Removes the file again when the insert fails. */
export async function createInspiration(
	sb: SupabaseClient,
	userId: string,
	file: Blob,
	fields: NewFields
): Promise<{ id: string }> {
	const ext = checkImage(file);
	const path = `${userId}/${crypto.randomUUID()}.${ext}`;
	const up = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type });
	if (up.error) throw new Error(`Αποτυχία ανεβάσματος: ${up.error.message}`);
	const { data, error } = await sb
		.from('inspirations')
		.insert({ ...fields, note: (fields.note ?? '').trim(), tags: cleanTags(fields.tags), image_path: path })
		.select('id')
		.single();
	if (error || !data) {
		await sb.storage.from(BUCKET).remove([path]);
		throw new Error(`Αποτυχία αποθήκευσης: ${error?.message ?? 'άγνωστο σφάλμα'}`);
	}
	return data;
}

/** Duplicate an inspiration (image file too) into `projectId`. The original stays as it is. */
export async function copyInspiration(
	sb: SupabaseClient,
	userId: string,
	id: string,
	projectId: string | null
): Promise<{ id: string }> {
	const { data: src, error } = await sb.from('inspirations').select('*').eq('id', id).maybeSingle();
	if (error) throw new Error(error.message);
	if (!src) throw new Error('Η εικόνα δεν βρέθηκε.');
	const row = src as Inspiration;
	const ext = row.image_path.split('.').pop() ?? 'png';
	const path = `${userId}/${crypto.randomUUID()}.${ext}`;
	const cp = await sb.storage.from(BUCKET).copy(row.image_path, path);
	if (cp.error) throw new Error(`Αποτυχία αντιγραφής εικόνας: ${cp.error.message}`);
	const { data, error: insErr } = await sb
		.from('inspirations')
		.insert({
			project_id: projectId,
			image_path: path,
			note: row.note,
			tags: row.tags,
			level: row.level,
			regions: row.regions,
			source_url: row.source_url,
			source_title: row.source_title
		})
		.select('id')
		.single();
	if (insErr || !data) {
		await sb.storage.from(BUCKET).remove([path]);
		throw new Error(`Αποτυχία αντιγραφής: ${insErr?.message ?? 'άγνωστο σφάλμα'}`);
	}
	return data;
}

/** The user's past tags, most used first (for one-click chips). */
export async function userTags(sb: SupabaseClient): Promise<string[]> {
	const { data, error } = await sb.rpc('user_tags');
	if (error) throw new Error(error.message);
	return (data as { tag: string }[]).map((r) => r.tag);
}
