// Page data cache (stale-while-revalidate). A page load answers the last known data at once (from
// memory, else localStorage) and asks the server in the background. When the answer differs, the
// cache keeps it and calls `refresh` (the page's invalidate); the load that this causes gets the new
// data without another request. A load with no cached copy waits for the server, as before.
//
// After a change the user made (upload, copy, delete...), the page calls forceNextLoad() before its
// invalidate: the next load of each key then waits for the server, so the change shows at once.
// Copies are per user (the key holds the user id); signing out clears them all (clearCached).

const PREFIX = 'mb:data:';
/** A key the server answered less than this long ago is not asked again (no reload loop). */
const RECHECK_MS = 30_000;

const mem = new Map<string, unknown>();
const fresh = new Map<string, unknown>();
const checkedAt = new Map<string, number>();
const seenGen = new Map<string, number>();
const inflight = new Set<string>();
/** Per key: the number of the newest read. */
const ver = new Map<string, number>();
/** Bumped by forceNextLoad (a change) and clearCached (sign-out). */
let gen = 0;
let epoch = 0;

function storage(): Storage | null {
	try {
		return (globalThis.localStorage as Storage | undefined) ?? null;
	} catch {
		return null;
	}
}

function read(key: string): unknown {
	if (mem.has(key)) return mem.get(key);
	const raw = (() => {
		try {
			return storage()?.getItem(PREFIX + key) ?? null;
		} catch {
			return null;
		}
	})();
	if (raw === null) return undefined;
	try {
		const v = JSON.parse(raw);
		mem.set(key, v);
		return v;
	} catch {
		return undefined;
	}
}

function write(key: string, v: unknown) {
	mem.set(key, v);
	try {
		storage()?.setItem(PREFIX + key, JSON.stringify(v));
	} catch {
		/* full or blocked: memory only */
	}
}

/** Start a server read of `key`. Its answer may be kept only while nothing newer happened: no other
 *  read of the key started, no change (forceNextLoad), no sign-out (clearCached). */
function startRead(key: string): () => boolean {
	const v = (ver.get(key) ?? 0) + 1;
	ver.set(key, v);
	const e = epoch;
	const g = gen;
	return () => ver.get(key) === v && epoch === e && gen === g;
}

/** The data for `key`: the cached copy at once (revalidated in the background), else the server's. */
export async function swrLoad<T>(key: string, fetcher: () => Promise<T>, refresh: () => void, now = Date.now): Promise<T> {
	const prevGen = seenGen.get(key) ?? 0;
	const forced = prevGen < gen;
	seenGen.set(key, gen);
	if (forced) fresh.delete(key);
	else if (fresh.has(key)) {
		const v = fresh.get(key) as T;
		fresh.delete(key);
		return v;
	}
	const cached = forced ? undefined : (read(key) as T | undefined);

	if (cached === undefined) {
		const valid = startRead(key);
		let v: T;
		try {
			v = await fetcher();
		} catch (e) {
			// A forced load that failed stays forced: the retry must ask the server again.
			if (forced && seenGen.get(key) === gen) seenGen.set(key, prevGen);
			throw e;
		}
		if (valid()) {
			write(key, v);
			checkedAt.set(key, now());
		}
		return v;
	}

	if (now() - (checkedAt.get(key) ?? -Infinity) >= RECHECK_MS && !inflight.has(key)) {
		checkedAt.set(key, now());
		inflight.add(key);
		const valid = startRead(key);
		const before = JSON.stringify(cached);
		fetcher()
			.then((v) => {
				if (!valid()) return;
				write(key, v);
				if (JSON.stringify(v) !== before) {
					fresh.set(key, v);
					refresh();
				}
			})
			.catch(() => {
				/* keep showing the cached copy */
			})
			.finally(() => inflight.delete(key));
	}
	return cached;
}

/** The next load of every key waits for the server (call it before invalidating after a change). */
export function forceNextLoad(): void {
	gen++;
}

/** Forget every cached copy (sign-out). */
export function clearCached(): void {
	epoch++;
	inflight.clear();
	mem.clear();
	fresh.clear();
	checkedAt.clear();
	seenGen.clear();
	const s = storage();
	try {
		const keys: string[] = [];
		for (let i = 0; s && i < s.length; i++) {
			const k = s.key(i);
			if (k?.startsWith(PREFIX)) keys.push(k);
		}
		for (const k of keys) s!.removeItem(k);
	} catch {
		/* blocked storage */
	}
}

/** Tests only. */
export function _reset(): void {
	clearCached();
	inflight.clear();
	ver.clear();
	gen = 0;
}

const ROW_WRITE = /\/api\/(collections\/(inspirations|projects|levels)\/records|mb\/inspirations\/)/;

/** Keep the cache true after a successful request of the app client (pb.afterSend): a change to
 *  rows makes the next loads ask the server. */
export function noteWrite(url: string, method: string, uid: string | null): void {
	if (!uid || method.toUpperCase() === 'GET') return;
	if (ROW_WRITE.test(new URL(url, 'http://x').pathname)) forceNextLoad();
}
