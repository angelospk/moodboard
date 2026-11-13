// Page data cache (stale-while-revalidate): a page shows the last known data at once, and the
// server answer replaces it when it comes.
import { beforeEach, describe, expect, it } from 'vitest';
import { clearCached, forceNextLoad, noteWrite, swrLoad, _reset } from '../src/lib/datacache';

class MemStorage {
	m = new Map<string, string>();
	get length() {
		return this.m.size;
	}
	key(i: number) {
		return [...this.m.keys()][i] ?? null;
	}
	getItem(k: string) {
		return this.m.get(k) ?? null;
	}
	setItem(k: string, v: string) {
		this.m.set(k, v);
	}
	removeItem(k: string) {
		this.m.delete(k);
	}
}

let store: MemStorage;
let clock = 1_000_000;
const now = () => clock;

/** A fetcher that answers the queued values in order and counts its calls. */
function source<T>(...values: T[]) {
	const f = async () => {
		f.calls++;
		const v = values.length > 1 ? values.shift()! : values[0];
		if (v instanceof Error) throw v;
		return v;
	};
	f.calls = 0;
	return f;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	store = new MemStorage();
	(globalThis as { localStorage?: unknown }).localStorage = store;
	clock = 1_000_000;
	_reset();
});

describe('swrLoad', () => {
	it('without a cached copy: waits for the server and keeps the answer', async () => {
		const f = source({ a: 1 });
		let refreshed = 0;
		expect(await swrLoad('k', f, () => refreshed++, now)).toEqual({ a: 1 });
		expect(f.calls).toBe(1);
		expect(refreshed).toBe(0);
		expect(JSON.parse(store.getItem('mb:data:k')!)).toEqual({ a: 1 });
	});

	it('with a cached copy: answers it at once, asks the server in the background, refreshes only on a change', async () => {
		store.setItem('mb:data:k', JSON.stringify({ a: 1 }));
		const f = source({ a: 2 });
		let refreshed = 0;
		expect(await swrLoad('k', f, () => refreshed++, now)).toEqual({ a: 1 });
		await tick();
		expect(f.calls).toBe(1);
		expect(refreshed).toBe(1);
		// The re-run the refresh causes gets the new answer, without another request.
		expect(await swrLoad('k', f, () => refreshed++, now)).toEqual({ a: 2 });
		expect(f.calls).toBe(1);
		expect(JSON.parse(store.getItem('mb:data:k')!)).toEqual({ a: 2 });
	});

	it('does not refresh when the server answer equals the cached copy', async () => {
		store.setItem('mb:data:k', JSON.stringify({ a: 1 }));
		const f = source({ a: 1 });
		let refreshed = 0;
		await swrLoad('k', f, () => refreshed++, now);
		await tick();
		expect(refreshed).toBe(0);
	});

	it('does not ask the server again for a key it checked in the last 30 s (no reload loop)', async () => {
		store.setItem('mb:data:k', JSON.stringify({ a: 1 }));
		const f = source({ a: 1 });
		await swrLoad('k', f, () => {}, now);
		await tick();
		clock += 10_000;
		expect(await swrLoad('k', f, () => {}, now)).toEqual({ a: 1 });
		await tick();
		expect(f.calls).toBe(1);
		clock += 25_000;
		await swrLoad('k', f, () => {}, now);
		await tick();
		expect(f.calls).toBe(2);
	});

	it('keeps the cached copy when the background request fails', async () => {
		store.setItem('mb:data:k', JSON.stringify({ a: 1 }));
		const f = source<{ a: number } | Error>(new Error('offline'));
		let refreshed = 0;
		expect(await swrLoad('k', f, () => refreshed++, now)).toEqual({ a: 1 });
		await tick();
		expect(refreshed).toBe(0);
		expect(JSON.parse(store.getItem('mb:data:k')!)).toEqual({ a: 1 });
	});

	it('throws a server error when there is no cached copy', async () => {
		await expect(swrLoad('k', source<unknown>(new Error('down')), () => {}, now)).rejects.toThrow('down');
	});

	it('after forceNextLoad (a change the user made): waits for the server once per key', async () => {
		store.setItem('mb:data:k', JSON.stringify({ a: 1 }));
		store.setItem('mb:data:j', JSON.stringify({ b: 1 }));
		const f = source({ a: 2 });
		const g = source({ b: 2 });
		forceNextLoad();
		expect(await swrLoad('k', f, () => {}, now)).toEqual({ a: 2 });
		expect(await swrLoad('j', g, () => {}, now)).toEqual({ b: 2 });
		expect(f.calls).toBe(1);
		// Consumed: the next load of the same key is served from the copy again.
		expect(await swrLoad('k', f, () => {}, now)).toEqual({ a: 2 });
		expect(f.calls).toBe(1);
	});

	it('works without storage (private mode): memory only', async () => {
		(globalThis as { localStorage?: unknown }).localStorage = undefined;
		const f = source({ a: 1 });
		expect(await swrLoad('k', f, () => {}, now)).toEqual({ a: 1 });
	});

	it('ignores a broken cached copy', async () => {
		store.setItem('mb:data:k', '{not json');
		expect(await swrLoad('k', source({ a: 3 }), () => {}, now)).toEqual({ a: 3 });
	});
});

describe('clearCached', () => {
	it('clearCached drops every cached copy and leaves other keys', async () => {
		store.setItem('mb:data:a', '1');
		store.setItem('mb:data:b', '2');
		store.setItem('moodboard:lang', 'el');
		await swrLoad('c', source(3), () => {}, now);
		clearCached();
		expect(store.getItem('mb:data:a')).toBeNull();
		expect(store.getItem('mb:data:b')).toBeNull();
		expect(store.getItem('moodboard:lang')).toBe('el');
		// Memory is cleared too: the next load waits for the server.
		const f = source(4);
		expect(await swrLoad('c', f, () => {}, now)).toBe(4);
	});
});

describe('noteWrite (every successful request of the app client)', () => {
	const B = 'https://api.test';
	it('a change to rows forces the next loads to ask the server', async () => {
		for (const [url, method] of [
			[`${B}/api/collections/inspirations/records`, 'POST'],
			[`${B}/api/collections/inspirations/records/abc`, 'PATCH'],
			[`${B}/api/collections/projects/records/abc`, 'DELETE'],
			[`${B}/api/collections/levels/records`, 'POST'],
			[`${B}/api/mb/inspirations/abc/copy`, 'POST'],
			[`${B}/api/mb/inspirations/abc/note`, 'POST']
		]) {
			_reset();
			store.setItem('mb:data:rows:u1', JSON.stringify(1));
			const f = source(2);
			noteWrite(url, method, 'u1');
			expect(await swrLoad('rows:u1', f, () => {}, now), `${method} ${url}`).toBe(2);
		}
	});

	it('reads, tokens, auth and realtime do not', async () => {
		for (const [url, method] of [
			[`${B}/api/collections/inspirations/records`, 'GET'],
			[`${B}/api/files/token`, 'POST'],
			[`${B}/api/collections/users/auth-refresh`, 'POST'],
			[`${B}/api/realtime`, 'POST'],
			[`${B}/api/mb/suggest`, 'POST']
		]) {
			_reset();
			store.setItem('mb:data:rows:u1', JSON.stringify(1));
			noteWrite(url, method, 'u1');
			expect(await swrLoad('rows:u1', source(2), () => {}, now), `${method} ${url}`).toBe(1);
		}
	});
});

describe('races (review findings)', () => {
	/** A fetcher whose answers the test releases by hand, in any order. */
	function manual<T>() {
		const waits: ((v: T) => void)[] = [];
		const f = () => new Promise<T>((r) => waits.push(r));
		return { f, release: (i: number, v: T) => waits[i](v) };
	}

	it('a background answer that lands after sign-out is dropped', async () => {
		store.setItem('mb:data:k', JSON.stringify(1));
		const m = manual<number>();
		await swrLoad('k', m.f, () => {}, now);
		clearCached();
		m.release(0, 2);
		await tick();
		expect(store.getItem('mb:data:k')).toBeNull();
	});

	it('a server answer that lands after sign-out is returned but not kept', async () => {
		const m = manual<number>();
		const p = swrLoad('k', m.f, () => {}, now);
		clearCached();
		m.release(0, 5);
		expect(await p).toBe(5);
		expect(store.getItem('mb:data:k')).toBeNull();
	});

	it('an older background answer does not overwrite a newer forced one', async () => {
		store.setItem('mb:data:k', JSON.stringify(1));
		const m = manual<number>();
		await swrLoad('k', m.f, () => {}, now); // background read #0 starts
		forceNextLoad();
		const p = swrLoad('k', m.f, () => {}, now); // forced read #1
		m.release(1, 3);
		expect(await p).toBe(3);
		m.release(0, 2); // the old answer lands last
		await tick();
		expect(JSON.parse(store.getItem('mb:data:k')!)).toBe(3);
	});

	it('forceNextLoad wins over a waiting fresh answer', async () => {
		store.setItem('mb:data:k', JSON.stringify(1));
		const f = source(2, 3);
		await swrLoad('k', f, () => {}, now);
		await tick(); // fresh = 2 waits for the re-run
		forceNextLoad();
		expect(await swrLoad('k', f, () => {}, now)).toBe(3);
		expect(f.calls).toBe(2);
	});
});

describe('forced load that fails', () => {
	it('stays forced: the retry asks the server again', async () => {
		store.setItem('mb:data:k', JSON.stringify(1));
		forceNextLoad();
		await expect(swrLoad('k', source<number | Error>(new Error('down')), () => {}, now)).rejects.toThrow('down');
		expect(await swrLoad('k', source(5), () => {}, now)).toBe(5);
	});
});
