// Public boards (server: server/mb/share.go). A public board opens at /s/<project id> for anyone with
// the link, no account. The owner picks what shows; the flags live on the project row.
import type PocketBase from 'pocketbase';
import { t } from './i18n.js';
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

/** Save only the given settings, so two quick changes cannot overwrite each other. */
export async function saveShare(pb: PocketBase, projectId: string, s: Partial<ShareSettings>): Promise<void> {
	const body: Record<string, boolean> = {};
	if (s.public !== undefined) body.public = s.public;
	if (s.notes !== undefined) body.share_hide_notes = !s.notes;
	if (s.regions !== undefined) body.share_hide_regions = !s.regions;
	if (s.tags !== undefined) body.share_hide_tags = !s.tags;
	if (s.sources !== undefined) body.share_show_sources = s.sources;
	await pb.collection('projects').update(projectId, body);
}

export function publicLink(projectId: string, origin = location.origin): string {
	return `${origin}/s/${projectId}`;
}

export function publicImageUrl(projectId: string, id: string, base = PB_URL): string {
	return `${base}/api/mb/public/${encodeURIComponent(projectId)}/files/${encodeURIComponent(id)}`;
}

/** Read a public board without a session. Throws «Το board δεν είναι δημόσιο.» when it is not. */
export async function loadPublic(projectId: string, base = PB_URL): Promise<PublicBoard> {
	const url = `${base}/api/mb/public/${encodeURIComponent(projectId)}`;
	// app.html may have started this request before the app's code loaded: use it once.
	const w = globalThis as { __mbBoard?: { url: string; res: Promise<Response> } };
	const early = w.__mbBoard?.url === url ? w.__mbBoard.res.catch(() => null) : null;
	if (w.__mbBoard) delete w.__mbBoard;
	const res = (await early) ?? (await fetch(url, { credentials: 'omit' }));
	if (res.status === 404) throw new Error(t('err.boardNotPublic'));
	if (!res.ok) throw new Error(t('err.loadStatus', { status: res.status }));
	const body = await res.json();
	return {
		project: body.project,
		inspirations: (body.inspirations ?? []).map(toInspiration),
		positions: body.positions ?? {}
	};
}
