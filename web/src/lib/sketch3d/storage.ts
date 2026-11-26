// Local copy of sketch documents in IndexedDB (works offline and over plain-http tailnet URLs).
// Every load goes through parseSketch. PocketBase sync comes later.
import { parseSketch, type SketchDoc } from './doc.js';

const DB = 'moodboard-sketch3d', STORE = 'docs';

// One connection, kept open: writes start without an open round trip, and transactions run in
// the order they were requested (the last save wins).
let conn: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
	conn ??= new Promise<IDBDatabase>((res, rej) => {
		const r = indexedDB.open(DB, 1);
		r.onupgradeneeded = () => r.result.createObjectStore(STORE);
		r.onsuccess = () => {
			const db = r.result;
			const drop = () => {
				db.close();
				conn = null;
			};
			db.onversionchange = drop;
			db.onclose = () => (conn = null);
			res(db);
		};
		r.onerror = () => {
			conn = null;
			rej(r.error);
		};
	});
	return conn;
}

async function run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	const db = await open();
	return new Promise<T>((res, rej) => {
		const tx = db.transaction(STORE, mode);
		const req = f(tx.objectStore(STORE));
		tx.oncomplete = () => res(req.result);
		tx.onerror = () => rej(tx.error);
		tx.onabort = () => rej(tx.error);
		tx.commit?.();
	});
}

/** A stored document that failed the gate. Its data was copied to `backup` first, so a new
 * document may take its key. */
export class UnreadableDoc extends Error {
	constructor(readonly backup: string, cause: unknown) {
		super(`stored sketch is unreadable; copied to ${backup}`, { cause });
	}
}

/** The stored document, null when there is none. Throws UnreadableDoc for invalid data, and the
 * IndexedDB error when the store cannot be read (then nothing may be written either). */
export async function loadDoc(id: string): Promise<SketchDoc | null> {
	const raw = await run('readonly', (s) => s.get(id));
	if (raw === undefined) return null;
	try {
		return parseSketch(raw);
	} catch (e) {
		const backup = `${id}.unreadable.${Date.now()}`;
		await run('readwrite', (s) => s.put(raw, backup));
		throw new UnreadableDoc(backup, e);
	}
}

export async function saveDoc(d: SketchDoc): Promise<void> {
	await run('readwrite', (s) => s.put(JSON.parse(JSON.stringify(d)), d.id));
}
