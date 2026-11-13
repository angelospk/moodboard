import { describe, expect, it } from 'vitest';
import { acceptsType, handle, parseTarget } from '../src/index.js';

const FILE = 'https://moodboard-api.haroldpoi.dev/api/mb/public/proj1/files/ins1';
const ENV = { ORIGIN: 'https://moodboard-api.haroldpoi.dev' };

/** A fake Cache API: stores by URL. */
function fakeCache() {
	const m = new Map();
	return {
		m,
		match: async (req) => m.get(req.url)?.clone(),
		put: async (req, res) => void m.set(req.url, res.clone())
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
		// Cloudflare picks the format from the Accept header we forward.
		expect(calls[0].init.cf.image).toEqual({ width: 1600, fit: 'scale-down', format: 'auto', quality: 85, metadata: 'none' });
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
		clock.t += 20_000; // 65 s old: expired, goes to the origin again
		await handle(get(FILE, { accept: 'image/webp' }), ENV, ctx(), deps);
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
