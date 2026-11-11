// Public boards (server: server/mb/share.go). A public board opens at /s/<project id> for anyone with
// the link, no account. The owner picks what shows; the flags live on the project row.
import type PocketBase from 'pocketbase';
import { PB_URL } from './pb.js';
import { toInspiration } from './inspirations.js';
import type { Inspiration } from './types.js';

export interface ShareSettings {
	public: boolean;
	notes: boolean;
	regions: boolean;
	/** Tags (zones, chips) and level. */
	tags: boolean;
	sources: boolean;
}

export const SHARE_DEFAULTS: ShareSettings = { public: false, notes: true, regions: true, tags: true, sources: false };

export interface PublicBoard {
	project: { name: string; description: string };
	inspirations: Inspiration[];
	positions: Record<string, { x: number; y: number }>;
}

export async function getShare(pb: PocketBase, projectId: string): Promise<ShareSettings> {
	const r = await pb.collection('projects').getOne(projectId);
	return {
		public: !!r.public,
		notes: !r.share_hide_notes,
		regions: !r.share_hide_regions,
		tags: !r.share_hide_tags,
		sources: !!r.share_show_sources
	};
}

export async function saveShare(pb: PocketBase, projectId: string, s: ShareSettings): Promise<void> {
	await pb.collection('projects').update(projectId, {
		public: s.public,
		share_hide_notes: !s.notes,
		share_hide_regions: !s.regions,
		share_hide_tags: !s.tags,
		share_show_sources: s.sources
	});
}

export function publicLink(projectId: string, origin = location.origin): string {
	return `${origin}/s/${projectId}`;
}

export function publicImageUrl(projectId: string, id: string, base = PB_URL): string {
	return `${base}/api/mb/public/${encodeURIComponent(projectId)}/files/${encodeURIComponent(id)}`;
}

/** Read a public board without a session. Throws «Το board δεν είναι δημόσιο.» when it is not. */
export async function loadPublic(projectId: string, base = PB_URL): Promise<PublicBoard> {
	const res = await fetch(`${base}/api/mb/public/${encodeURIComponent(projectId)}`, { credentials: 'omit' });
	if (res.status === 404) throw new Error('Το board δεν είναι δημόσιο.');
	if (!res.ok) throw new Error(`Σφάλμα φόρτωσης (${res.status}).`);
	const body = await res.json();
	return {
		project: body.project,
		inspirations: (body.inspirations ?? []).map(toInspiration),
		positions: body.positions ?? {}
	};
}
