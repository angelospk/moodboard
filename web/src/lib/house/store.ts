// House models in PocketBase (collection house_models): one autosaved draft per project plus named
// versions. The client acts as the signed-in user, so the API rules limit every call to own rows.
import type PocketBase from 'pocketbase';
import { parseModel, type HouseModel } from './model.js';

const COLLECTION = 'house_models';

export interface VersionInfo {
	id: string;
	name: string;
	created_at: string;
}

const isNotFound = (e: unknown): boolean => (e as { status?: number })?.status === 404;

/** The project's draft row, or null when there is none yet. */
async function findDraft(pb: PocketBase, projectId: string) {
	try {
		return await pb.collection(COLLECTION).getFirstListItem(pb.filter('kind = "draft" && project_id = {:p}', { p: projectId }));
	} catch (e) {
		if (isNotFound(e)) return null;
		throw e;
	}
}

/** The stored draft row after a save: its id and the server's time of that write. */
export interface SavedDraft {
	id: string;
	updated_at: string;
}
const saved = (r: { id: string; updated_at: string }): SavedDraft => ({ id: r.id, updated_at: r.updated_at });

/** Draft saves still running in this tab, per project: a load waits for them, so leaving a project
 *  and coming back (A → B → A) never shows a draft older than the last edit. */
const inflight = new Map<string, Promise<unknown>>();

/** Register the editor's whole save queue for a project (also saves not started yet), so a load waits for it. */
export function trackDraftSave(projectId: string, queue: Promise<unknown>) {
	inflight.set(projectId, queue);
	void queue.finally(() => {
		if (inflight.get(projectId) === queue) inflight.delete(projectId);
	}).catch(() => {});
}

export async function loadDraft(pb: PocketBase, projectId: string): Promise<{ id: string; model: HouseModel; updated_at: string } | null> {
	// Wait until no save queue is left: one may replace another while we wait.
	for (let q = inflight.get(projectId); q; q = inflight.get(projectId)) {
		await q.catch(() => {});
		if (inflight.get(projectId) === q) break;
	}
	const row = await findDraft(pb, projectId);
	return row ? { id: row.id, model: parseModel(row.model), updated_at: row.updated_at } : null;
}

/**
 * Create or overwrite the project's one draft and return its id and write time. With `knownId` (from an earlier
 * load or save) it is a single update. Drafts are last-writer-wins: the editor sends its saves one at
 * a time, and two devices editing at once is out of scope (no realtime merge yet).
 */
export function saveDraft(pb: PocketBase, userId: string, projectId: string, model: HouseModel, knownId: string | null = null): Promise<SavedDraft> {
	const p = writeDraft(pb, userId, projectId, model, knownId);
	if (!inflight.has(projectId)) trackDraftSave(projectId, p); // a tracked queue already covers this write
	return p;
}

async function writeDraft(pb: PocketBase, userId: string, projectId: string, model: HouseModel, knownId: string | null): Promise<SavedDraft> {
	if (knownId) {
		try {
			return saved(await pb.collection(COLLECTION).update(knownId, { model }));
		} catch (e) {
			if (!isNotFound(e)) throw e; // the row is gone: create it again below
		}
	}
	const existing = await findDraft(pb, projectId);
	if (existing) {
		return saved(await pb.collection(COLLECTION).update(existing.id, { model }));
	}
	try {
		return saved(await pb.collection(COLLECTION).create({ user_id: userId, project_id: projectId, kind: 'draft', name: '', model }));
	} catch (e) {
		// A concurrent save created the draft first: the unique index rejects ours with 400. Update that row.
		const raced = await findDraft(pb, projectId);
		if (!raced) throw e;
		return saved(await pb.collection(COLLECTION).update(raced.id, { model }));
	}
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Keep a named copy of the model. An empty name becomes "Έκδοση YYYY-MM-DD HH:MM" in local time. */
export async function saveVersion(pb: PocketBase, userId: string, projectId: string, name: string, model: HouseModel): Promise<VersionInfo> {
	let clean = name.trim().replace(/\s+/g, ' ').slice(0, 120);
	if (!clean) {
		const d = new Date();
		clean = `Έκδοση ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}
	const row = await pb.collection(COLLECTION).create({ user_id: userId, project_id: projectId, kind: 'version', name: clean, model });
	return { id: row.id, name: row.name, created_at: row.created_at };
}

/** Versions of a project, newest first. The model JSON stays on the server until one is opened. */
export async function listVersions(pb: PocketBase, projectId: string): Promise<VersionInfo[]> {
	const rows = await pb.collection(COLLECTION).getFullList({
		filter: pb.filter('kind = "version" && project_id = {:p}', { p: projectId }),
		sort: '-created_at,-id',
		fields: 'id,name,created_at'
	});
	return rows.map((r) => ({ id: r.id, name: r.name, created_at: r.created_at }));
}

export async function loadVersion(pb: PocketBase, id: string): Promise<HouseModel> {
	const row = await pb.collection(COLLECTION).getOne(id);
	return parseModel(row.model);
}
