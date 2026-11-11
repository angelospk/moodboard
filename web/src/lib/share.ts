// Read-only share links of a board (server: server/mb/share.go). The owner makes one link per project
// (a new one replaces the old) and can revoke it; anyone with the link reads that board, no account.
import type PocketBase from 'pocketbase';
import { PB_URL } from './pb.js';
import { toInspiration } from './inspirations.js';
import type { Inspiration } from './types.js';

export interface ShareStatus {
	active: boolean;
	created_at?: string;
}

export interface SharedBoard {
	project: { name: string; description: string };
	inspirations: Inspiration[];
	positions: Record<string, { x: number; y: number }>;
}

const path = (projectId: string) => `/api/mb/projects/${encodeURIComponent(projectId)}/share`;

export function shareStatus(pb: PocketBase, projectId: string): Promise<ShareStatus> {
	return pb.send(path(projectId), { method: 'GET' });
}

/** Make a new link (the old one stops working) and return its token. The server keeps only a hash. */
export async function createShare(pb: PocketBase, projectId: string): Promise<string> {
	const res: { token: string } = await pb.send(path(projectId), { method: 'POST' });
	return res.token;
}

export async function revokeShare(pb: PocketBase, projectId: string): Promise<void> {
	await pb.send(path(projectId), { method: 'DELETE' });
}

export function shareLink(token: string, origin = location.origin): string {
	return `${origin}/s/${token}`;
}

export function sharedImageUrl(token: string, id: string, base = PB_URL): string {
	return `${base}/api/mb/shared/${encodeURIComponent(token)}/files/${encodeURIComponent(id)}`;
}

/** Read a shared board without a session. Throws «Ο σύνδεσμος δεν ισχύει.» for an unknown or revoked link. */
export async function loadShared(token: string, base = PB_URL): Promise<SharedBoard> {
	const res = await fetch(`${base}/api/mb/shared/${encodeURIComponent(token)}`, { credentials: 'omit' });
	if (res.status === 404) throw new Error('Ο σύνδεσμος δεν ισχύει.');
	if (!res.ok) throw new Error(`Σφάλμα φόρτωσης (${res.status}).`);
	const body = await res.json();
	return {
		project: body.project,
		inspirations: (body.inspirations ?? []).map(toInspiration),
		positions: body.positions ?? {}
	};
}
