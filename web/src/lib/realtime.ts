// Live updates over PocketBase realtime (SSE). The server sends every create/update/delete of the
// user's own rows (the collection list rule filters them); applyEvent folds one into the shown list.
import type PocketBase from 'pocketbase';
import type { RecordSubscription, RecordModel } from 'pocketbase';
import type { Inspiration } from '#lib/types.js';
import { isNewer, toInspiration } from '#lib/inspirations.js';

/** The list after one realtime event. Returns the same array when nothing changes, so callers can
 *  skip a re-render. An update replaces a row only when it is strictly newer (a late echo of an older
 *  own save must not undo a newer one); a create of a row already shown (own add) is ignored. */
export function applyEvent(items: Inspiration[], e: { action: string; record: RecordModel }): Inspiration[] {
	const id = e.record.id;
	const at = items.findIndex((i) => i.id === id);
	if (e.action === 'delete') return at < 0 ? items : items.filter((i) => i.id !== id);
	const row = toInspiration(e.record);
	if (at < 0) return e.action === 'create' || e.action === 'update' ? [row, ...items] : items;
	if (!isNewer(row, items[at])) return items;
	const next = items.slice();
	next[at] = { ...items[at], ...row };
	return next;
}

type Positions = Record<string, { x: number; y: number }>;
type PositionEvent = { action: string; record: { scope: string; node_key: string; x: number; y: number } };

/** The saved positions of one map after a realtime event. Returns the same object when nothing
 *  changes (another map, a bad row, an own echo of the same spot). */
export function applyPositionEvent(pos: Positions, scope: string, e: PositionEvent): Positions {
	const { scope: sc, node_key: key, x, y } = e.record;
	if (sc !== scope) return pos;
	if (e.action === 'delete') {
		if (!(key in pos)) return pos;
		const { [key]: _gone, ...rest } = pos;
		return rest;
	}
	if (!Number.isFinite(x) || !Number.isFinite(y)) return pos;
	if (pos[key]?.x === x && pos[key]?.y === y) return pos;
	return { ...pos, [key]: { x, y } };
}

export interface LiveHandlers {
	inspiration: (e: RecordSubscription<RecordModel>) => void;
	/** A project was created, renamed or deleted. */
	project: () => void;
	/** A card was moved (or its spot forgotten) on another tab or device. */
	position?: (e: PositionEvent) => void;
}

/** Subscribe to the user's inspirations, projects and (when asked) map positions. Returns an
 *  unsubscribe function. */
export async function subscribeLive(pb: PocketBase, h: LiveHandlers): Promise<() => Promise<void>> {
	const offs = await Promise.all([
		pb.collection('inspirations').subscribe('*', h.inspiration),
		pb.collection('projects').subscribe('*', () => h.project()),
		// A failing positions subscription must not break the other two.
		...(h.position
			? [pb.collection('map_positions').subscribe('*', (e) => h.position!(e as unknown as PositionEvent)).catch(() => async () => {})]
			: [])
	]);
	return async () => {
		await Promise.all(offs.map((off) => off().catch(() => {})));
	};
}
