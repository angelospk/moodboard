import { describe, expect, it } from 'vitest';
import { acceptsType, handle, parseTarget, STALE } from '../src/index.js';

const FILE = 'https://moodboard-api.haroldpoi.dev/api/mb/public/proj1/files/ins1';
const ENV = { ORIGIN: 'https://moodboard-api.haroldpoi.dev' };

/** A fake Cache API: stores by URL. */
function fakeCache() {
	const m = new Map();
	return {
		m,
		match: async (req) => m.get(req.url)?.clone(),
		put: async (req, res) => void m.set(req.url, res.clone()),
		delete: async (req) => m.delete(req.url)
	};
}
const ctx = () => {
	const jobs = [];
	return { jobs, waitUntil: (p) => void jobs.push(p), done: () => Promise.all(jobs) };
};
function setup(originResponses) {
	const calls = [];
	const queue = Array.isArray(originResponses) ? [...originResponses] : [originResponses];
	const fetch = async (input, init) => {
		calls.push({ url: String(input.url ?? input), init });
		const next = queue.length > 1 ? queue.shift() : queue[0];
		return typeof next === 'function' ? next() : next.clone();
	};
	const clock = { t: 1_000_000 };
	return { calls, clock, deps: { fetch, cache: fakeCache(), now: () => clock.t } };
}
const ok = (type = 'image/webp') =>
	new Response('IMG', { status: 200, headers: { 'content-type': type, 'cache-control': 'private, max-age=300' } });
const get = (url, headers = {}) => new Request(url, { headers });

describe('parseTarget', () => {
	it('knows public file URLs and their size', () => {
		expect(parseTarget(new URL(FILE))).toEqual({ width: 1600 });
		expect(parseTarget(new URL(FILE + '?thumb=480x0'))).toEqual({ width: 480 });
	});
	it('ignores everything else', () => {
		for (const u of [
			'https://x.dev/api/mb/public/proj1',
			'https://x.dev/api/mb/public/proj1/files/ins1/extra',
			'https://x.dev/api/mb/public/proj1/files/',
			'https://x.dev/api/collections/inspirations/records',
			FILE + '?thumb=999x0'
		]) {
			expect(parseTarget(new URL(u))).toBeNull();
		}
	});
});

describe('acceptsType', () => {
	it('reads types, wildcards and q values', () => {
		expect(acceptsType('image/avif,image/webp,*/*', 'image/webp')).toBe(true);
		expect(acceptsType('image/webp', 'image/png')).toBe(false);
		expect(acceptsType('image/*', 'image/png')).toBe(true);
		expect(acceptsType('*/*;q=0.8', 'image/jpeg')).toBe(true);
		expect(acceptsType('image/avif;q=0,image/webp', 'image/avif')).toBe(false);
		expect(acceptsType('image/avif;q=0,image/webp', 'image/webp')).toBe(true);
		expect(acceptsType('image/webp;q=0, */*', 'image/webp')).toBe(false); // an explicit q=0 beats the wildcard
		expect(acceptsType(null, 'image/webp')).toBe(true); // no header: anything goes
	});
});

describe('handle', () => {
	it('resizes and strips metadata on a miss, caches it, and answers private for the browser', async () => {
		const { calls, deps } = setup(ok('image/avif'));
		const c = ctx();
		const res = await handle(get(FILE, { accept: 'image/avif,image/webp' }), ENV, c, deps);
		await c.done();
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('IMG');
		expect(res.headers.get('cache-control')).toBe('private, max-age=60');
		expect(res.headers.get('vary')).toMatch(/accept/i);
		expect(res.headers.get('access-control-allow-origin')).toBe('*'); // public images, like the API answers
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(FILE);
		// The format follows the Accept header ('auto' would keep a PNG as PNG).
		expect(calls[0].init.cf.image).toEqual({ width: 1600, fit: 'scale-down', format: 'avif', quality: 85, metadata: 'none' });
		expect(calls[0].init.headers.accept).toBe('image/avif,image/webp');
		expect(deps.cache.m.size).toBe(1);
		expect([...deps.cache.m.keys()][0]).toContain('w=1600');
	});

	it('serves the second request from the cache without calling the origin', async () => {
		const { calls, deps } = setup(ok());
		const c = ctx();
		await handle(get(FILE, { accept: 'image/webp' }), ENV, c, deps);
		await c.done();
		const again = await handle(get(FILE, { accept: 'image/webp' }), ENV, ctx(), deps);
		expect(await again.text()).toBe('IMG');
		expect(calls).toHaveLength(1);
	});

	it('gives the browser only the freshness that is left, never a new full TTL', async () => {
		const { calls, clock, deps } = setup(ok());
		const c = ctx();
		await handle(get(FILE, { accept: 'image/webp' }), ENV, c, deps);
		await c.done();
		clock.t += 45_000; // 45 s old
		const aged = await handle(get(FILE, { accept: 'image/webp' }), ENV, ctx(), deps);
		expect(aged.headers.get('cache-control')).toBe('private, max-age=15');
		clock.t += 20_000; // 65 s old: past TTL, so the origin is asked again (the old copy is only a stand-in, see below)
		const c2 = ctx();
		await handle(get(FILE, { accept: 'image/webp' }), ENV, c2, deps);
		await c2.done();
		expect(calls).toHaveLength(2);
	});

	it('does not serve a stored type the client cannot decode', async () => {
		const { calls, deps } = setup([ok('image/avif'), ok('image/jpeg')]);
		const c = ctx();
		await handle(get(FILE, { accept: 'image/avif,image/webp' }), ENV, c, deps); // stores avif
		await c.done();
		const res = await handle(get(FILE, { accept: 'image/jpeg;q=1, image/avif;q=0' }), ENV, ctx(), deps);
		expect(res.headers.get('content-type')).toBe('image/jpeg');
		expect(calls).toHaveLength(2);
		expect(calls[1].init?.cf?.image).toBeUndefined(); // the plain origin file
	});

	it('uses 480 px for thumbnails, kept apart from full size', async () => {
		const { calls, deps } = setup(ok());
		const c = ctx();
		await handle(get(FILE + '?thumb=480x0', { accept: 'image/webp' }), ENV, c, deps);
		await handle(get(FILE, { accept: 'image/webp' }), ENV, c, deps);
		await c.done();
		expect(calls.map((x) => x.init.cf.image.width)).toEqual([480, 1600]);
	});

	it('passes a 404 through and never caches it (private or missing board)', async () => {
		const { calls, deps } = setup(new Response('nope', { status: 404 }));
		const c = ctx();
		const res = await handle(get(FILE), ENV, c, deps);
		await c.done();
		expect(res.status).toBe(404);
		expect(calls).toHaveLength(1); // no plain retry for a 404
		expect(deps.cache.m.size).toBe(0);
	});

	it('falls back to the plain origin file when the resizer answers with an error, and does not cache that', async () => {
		const { calls, deps } = setup([new Response('resizer error', { status: 502 }), ok('image/png')]);
		const c = ctx();
		const res = await handle(get(FILE, { accept: 'image/webp' }), ENV, c, deps);
		await c.done();
		expect(res.status).toBe(200);
		expect(calls).toHaveLength(2);
		expect(calls[0].init.cf.image).toBeTruthy();
		expect(calls[1].init?.cf?.image).toBeUndefined();
		expect(deps.cache.m.size).toBe(0);
	});

	it('falls back to the plain origin file when the resizer fetch rejects', async () => {
		const { calls, deps } = setup([() => Promise.reject(new Error('9422 quota')), ok('image/png')]);
		const res = await handle(get(FILE, { accept: 'image/webp' }), ENV, ctx(), deps);
		expect(res.status).toBe(200);
		expect(calls).toHaveLength(2);
		expect(calls[1].init?.cf?.image).toBeUndefined();
	});

	it('does not touch other requests', async () => {
		for (const [method, url] of [
			['POST', FILE],
			['HEAD', FILE],
			['GET', 'https://moodboard-api.haroldpoi.dev/api/mb/public/proj1']
		]) {
			const { calls, deps } = setup(ok());
			await handle(new Request(url, { method }), ENV, ctx(), deps);
			expect(calls).toHaveLength(1);
			expect(calls[0].init?.cf?.image).toBeUndefined();
		}
	});

	it('does not loop when the request comes from the resizer itself', async () => {
		const { calls, deps } = setup(ok());
		await handle(get(FILE, { via: '1.1 image-resizing' }), ENV, ctx(), deps);
		expect(calls).toHaveLength(1);
		expect(calls[0].init?.cf?.image).toBeUndefined();
	});

	it('always asks the configured origin, never a host from the request', async () => {
		const { calls, deps } = setup(ok());
		await handle(get('https://moodboard-img.workers.dev/api/mb/public/proj1/files/ins1'), ENV, ctx(), deps);
		expect(calls[0].url).toBe(FILE);
	});
});

describe('public board JSON', () => {
	const BOARD = 'https://moodboard-api.haroldpoi.dev/api/mb/public/proj1';
	const json = () =>
		new Response('{"project":{"name":"P"}}', { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

	it('keeps the board at the edge for TTL seconds and gives the browser what is left', async () => {
		const { calls, clock, deps } = setup(json());
		let c = ctx();
		let res = await handle(get(BOARD), ENV, c, deps);
		await c.done();
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('{"project":{"name":"P"}}');
		expect(res.headers.get('content-type')).toBe('application/json');
		expect(res.headers.get('cache-control')).toBe('private, max-age=60');
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(BOARD);

		clock.t += 20_000;
		c = ctx();
		res = await handle(get(BOARD), ENV, c, deps);
		await c.done();
		expect(await res.text()).toBe('{"project":{"name":"P"}}');
		expect(res.headers.get('cache-control')).toBe('private, max-age=40');
		expect(calls).toHaveLength(1); // served from the edge

		clock.t += 41_000; // past TTL: ask the VPS again (it decides public/private)
		c = ctx();
		res = await handle(get(BOARD), ENV, c, deps);
		await c.done();
		expect(res.status).toBe(200);
		expect(calls).toHaveLength(2);
	});

	it('never caches a 404 (private or unknown board)', async () => {
		const { calls, deps } = setup(new Response('{"message":"x"}', { status: 404 }));
		for (let i = 0; i < 2; i++) {
			const c = ctx();
			const res = await handle(get(BOARD), ENV, c, deps);
			await c.done();
			expect(res.status).toBe(404);
		}
		expect(calls).toHaveLength(2);
	});

	it('does not cache an error answer', async () => {
		const { calls, deps } = setup([new Response('down', { status: 502 }), json()]);
		let c = ctx();
		expect((await handle(get(BOARD), ENV, c, deps)).status).toBe(502);
		await c.done();
		c = ctx();
		expect((await handle(get(BOARD), ENV, c, deps)).status).toBe(200);
		await c.done();
		expect(calls).toHaveLength(2);
	});

	it('passes other methods and URLs with a query through unchanged', async () => {
		const { calls, deps } = setup(json());
		for (const req of [new Request(BOARD, { method: 'POST' }), get(BOARD + '?x=1'), get(BOARD), get(BOARD + '?x=1')]) {
			const c = ctx();
			await handle(req, ENV, c, deps);
			await c.done();
		}
		// POST and the two query URLs reach the VPS; the plain GET is fetched once.
		expect(calls).toHaveLength(4);
	});

	it('keeps boards apart', async () => {
		const { calls, deps } = setup(json());
		for (const u of [BOARD, BOARD.replace('proj1', 'proj2'), BOARD, BOARD.replace('proj1', 'proj2')]) {
			const c = ctx();
			await handle(get(u), ENV, c, deps);
			await c.done();
		}
		expect(calls).toHaveLength(2);
	});
});

describe('stale while revalidate', () => {
	const BOARD = 'https://moodboard-api.haroldpoi.dev/api/mb/public/proj1';
	const json = (name) => () =>
		new Response(`{"project":{"name":"${name}"}}`, { status: 200, headers: { 'content-type': 'application/json' } });
	const fetchOf = (...answers) => setup(answers.map((a) => (typeof a === 'string' ? json(a) : a)));
	const run = async (req, deps) => {
		const c = ctx();
		const res = await handle(req, ENV, c, deps);
		const text = await res.clone().text();
		await c.done();
		return { res, text };
	};

	it('stores copies with a max-age as long as STALE, or the Cache API would drop them at TTL', async () => {
		const { deps } = fetchOf('old');
		await run(get(BOARD), deps);
		const img = setup(ok('image/webp'));
		await run(get(FILE, { accept: 'image/webp' }), img.deps);
		for (const stored of [...deps.cache.m.values(), ...img.deps.cache.m.values()]) {
			expect(stored.headers.get('cache-control')).toBe(`public, max-age=${STALE}`);
		}
	});

	it('serves an old board at once, refreshes it in the background, and the next visitor gets the new one', async () => {
		const { calls, clock, deps } = fetchOf('old', 'new');
		await run(get(BOARD), deps);
		clock.t += 600_000; // 10 min old: past TTL, inside STALE
		const stale = await run(get(BOARD), deps);
		expect(stale.text).toContain('old');
		expect(stale.res.headers.get('cache-control')).toBe('private, max-age=0'); // the browser must ask again
		expect(calls).toHaveLength(2); // the refresh
		const next = await run(get(BOARD), deps);
		expect(next.text).toContain('new');
		expect(next.res.headers.get('cache-control')).toBe('private, max-age=60');
		expect(calls).toHaveLength(2);
	});

	it('drops the old board when the refresh says 404, so the next visitor gets 404 (made private)', async () => {
		const { calls, clock, deps } = fetchOf('old', new Response('{"message":"x"}', { status: 404 }));
		await run(get(BOARD), deps);
		clock.t += 600_000;
		expect((await run(get(BOARD), deps)).text).toContain('old'); // the one stale answer
		expect(deps.cache.m.size).toBe(0);
		const next = await run(get(BOARD), deps);
		expect(next.res.status).toBe(404);
		expect(calls).toHaveLength(3);
	});

	it('keeps the old copy (marked as served) when the refresh fails with a server error or a network error', async () => {
		for (const failure of [new Response('down', { status: 502 }), () => Promise.reject(new Error('net'))]) {
			const { clock, deps } = fetchOf('old', failure);
			await run(get(BOARD), deps);
			clock.t += 600_000;
			expect((await run(get(BOARD), deps)).text).toContain('old');
			expect(deps.cache.m.size).toBe(1);
			expect([...deps.cache.m.values()][0].headers.get('x-stale-served')).toBe('1');
		}
	});

	it('does not serve a board older than STALE: it asks the VPS first', async () => {
		const { calls, clock, deps } = fetchOf('old', new Response('', { status: 404 }));
		await run(get(BOARD), deps);
		clock.t += (STALE + 1) * 1000;
		const res = await run(get(BOARD), deps);
		expect(res.res.status).toBe(404);
		expect(calls).toHaveLength(2);
	});

	it('starts one refresh for many visitors of the same old board', async () => {
		const { calls, clock, deps } = fetchOf('old', 'new');
		await run(get(BOARD), deps);
		clock.t += 600_000;
		const c = ctx();
		await Promise.all([handle(get(BOARD), ENV, c, deps), handle(get(BOARD), ENV, c, deps), handle(get(BOARD), ENV, c, deps)]);
		await c.done();
		expect(calls).toHaveLength(2);
	});

	it('serves an old image at once, then refreshes it; a 404 removes it', async () => {
		const { calls, clock, deps } = setup([ok('image/webp'), new Response('', { status: 404 })]);
		await run(get(FILE, { accept: 'image/webp' }), deps);
		clock.t += 600_000;
		const stale = await run(get(FILE, { accept: 'image/webp' }), deps);
		expect(stale.text).toBe('IMG');
		expect(stale.res.headers.get('cache-control')).toBe('private, max-age=0');
		expect(calls).toHaveLength(2);
		expect(calls[1].init.cf.image.width).toBe(1600);
		expect(deps.cache.m.size).toBe(0);
		const next = await run(get(FILE, { accept: 'image/webp' }), deps);
		expect(next.res.status).toBe(404);
	});

	it('an old image is replaced by the refresh when it succeeds', async () => {
		const fresh = () => new Response('IMG2', { status: 200, headers: { 'content-type': 'image/webp' } });
		const { clock, deps } = setup([ok('image/webp'), fresh]);
		await run(get(FILE, { accept: 'image/webp' }), deps);
		clock.t += 600_000;
		expect((await run(get(FILE, { accept: 'image/webp' }), deps)).text).toBe('IMG');
		expect((await run(get(FILE, { accept: 'image/webp' }), deps)).text).toBe('IMG2');
	});
});

describe('an old copy is served once', () => {
	const BOARD = 'https://moodboard-api.haroldpoi.dev/api/mb/public/proj1';
	const json = (name) => () => new Response(`{"project":{"name":"${name}"}}`, { status: 200, headers: { 'content-type': 'application/json' } });
	const run = async (req, deps) => {
		const c = ctx();
		const res = await handle(req, ENV, c, deps);
		const text = await res.clone().text();
		await c.done();
		return { res, text };
	};

	it('does not serve a board again when its refresh failed: the next visitor waits for the origin', async () => {
		const { calls, clock, deps } = setup([json('old'), new Response('down', { status: 502 })]);
		await run(get(BOARD), deps);
		clock.t += 600_000;
		expect((await run(get(BOARD), deps)).text).toContain('old'); // the one stale answer; its refresh gets 502
		const next = await run(get(BOARD), deps);
		expect(next.res.status).toBe(502); // asked the origin itself, did not serve the old copy
		expect(next.text).not.toContain('old');
		expect(calls).toHaveLength(3);
	});

	it('does not serve an image again when its refresh failed', async () => {
		const { calls, clock, deps } = setup([ok('image/webp'), new Response('down', { status: 502 }), ok('image/png')]);
		await run(get(FILE, { accept: 'image/webp' }), deps);
		clock.t += 600_000;
		expect((await run(get(FILE, { accept: 'image/webp' }), deps)).res.headers.get('cache-control')).toBe('private, max-age=0');
		calls.length = 0;
		const next = await run(get(FILE, { accept: 'image/webp' }), deps);
		expect(next.res.headers.get('cache-control')).not.toBe('private, max-age=0');
		expect(calls.length).toBeGreaterThan(0); // went to the origin
	});

	it('a successful refresh makes the copy fresh again, with no mark left', async () => {
		const { clock, deps } = setup([json('old'), json('new')]);
		await run(get(BOARD), deps);
		clock.t += 600_000;
		await run(get(BOARD), deps);
		expect([...deps.cache.m.values()][0].headers.get('x-stale-served')).toBeNull();
		expect((await run(get(BOARD), deps)).text).toContain('new');
	});

	it('still refreshes when writing the served marker fails (a 404 then removes the copy)', async () => {
		const { calls, clock, deps } = setup([json('old'), new Response('{"message":"x"}', { status: 404 })]);
		await run(get(BOARD), deps);
		clock.t += 600_000;
		const real = deps.cache.put;
		let fail = true;
		deps.cache.put = async (...a) => {
			if (fail) { fail = false; throw new Error('cache write failed'); }
			return real(...a);
		};
		expect((await run(get(BOARD), deps)).text).toContain('old');
		expect(calls).toHaveLength(2); // the refresh ran although the marker write threw
		expect(deps.cache.m.size).toBe(0);
		expect((await run(get(BOARD), deps)).res.status).toBe(404);
	});
});
