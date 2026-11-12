// The user's own levels ("επίπεδα"): an ordered list per account. inspirations.level holds a level id;
// deleting a level clears it on the images (server: migrations/1763500000_levels.go, mb/levels.go).
import type PocketBase from 'pocketbase';
import type { RecordModel } from 'pocketbase';
import { msg } from '#lib/inspirations.js';

export interface LevelRow {
	id: string;
	name: string;
	position: number;
}

export const MAX_LEVEL_NAME = 40;

function toRow(r: RecordModel): LevelRow {
	return { id: r.id, name: r.name, position: r.position ?? 0 };
}

export async function listLevels(pb: PocketBase): Promise<LevelRow[]> {
	const rows = await pb.collection('levels').getFullList({ sort: 'position,created_at' });
	return rows.map(toRow);
}

/** The name of a level, or '' for none or a level that no longer exists. */
export function levelName(rows: LevelRow[], id: string | null | undefined): string {
	return (id && rows.find((l) => l.id === id)?.name) || '';
}

function checkName(name: string): string {
	const n = name.trim();
	if (!n) throw new Error('Γράψε ένα όνομα.');
	if (n.length > MAX_LEVEL_NAME) throw new Error(`Το πολύ ${MAX_LEVEL_NAME} χαρακτήρες.`);
	return n;
}

/** Add a level at the end of the list. */
export async function addLevel(pb: PocketBase, userId: string, name: string): Promise<LevelRow> {
	const n = checkName(name);
	const rows = await listLevels(pb);
	try {
		const r = await pb.collection('levels').create({
			user_id: userId,
			name: n,
			position: rows.reduce((m, l) => Math.max(m, l.position), -1) + 1
		});
		return toRow(r);
	} catch (e) {
		throw new Error(msg(e));
	}
}

export async function renameLevel(pb: PocketBase, id: string, name: string): Promise<LevelRow> {
	const n = checkName(name);
	try {
		return toRow(await pb.collection('levels').update(id, { name: n }));
	} catch (e) {
		throw new Error(msg(e));
	}
}

/** Remove a level. Images keep their place; they just lose this level. */
export async function deleteLevel(pb: PocketBase, id: string): Promise<void> {
	try {
		await pb.collection('levels').delete(id);
	} catch (e) {
		throw new Error(msg(e));
	}
}

/** Move a level one step up (-1) or down (+1). Returns the new list; saves only the rows that changed. */
export async function moveLevel(pb: PocketBase, rows: LevelRow[], id: string, dir: -1 | 1): Promise<LevelRow[]> {
	const from = rows.findIndex((l) => l.id === id);
	const to = from + dir;
	if (from < 0 || to < 0 || to >= rows.length) return rows;
	const next = [...rows];
	[next[from], next[to]] = [next[to], next[from]];
	const out = next.map((l, i) => ({ ...l, position: i }));
	try {
		await Promise.all(
			out.filter((l, i) => rows[i].id !== l.id || rows[i].position !== l.position).map((l) => pb.collection('levels').update(l.id, { position: l.position }))
		);
	} catch (e) {
		throw new Error(msg(e));
	}
	return out;
}
