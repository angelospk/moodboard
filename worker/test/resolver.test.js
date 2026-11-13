import { describe, expect, it } from 'vitest';
import { handle } from '../src/index.js';

const ORIGIN = 'https://moodboard-api.haroldpoi.dev';
const IMAGES = 'https://images.haroldpoi.dev';
const FILE = `${ORIGIN}/api/mb/public/proj1/files/ins1`;
const ENV = { ORIGIN, IMAGES, RESOLVE_SECRET: 's3cret' };
const KEY = 'mbinspirations/ins1/image_ab12.png';
const THUMB = 'mbinspirations/ins1/thumbs_image_ab12.png/480x0_image_ab12.png';

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
const resolved = (body = { key: KEY, thumb: THUMB }) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const resized = (type = 'image/webp') => new Response('RESIZED', { status: 200, headers: { 'content-type': type, 'cf-resized': 'internal=ok/h q=0 n=1+0 c=1+1 v=2026.11.2 l=7 f=true c2=0' } });
const plain = () => new Response('PLAIN', { status: 200, headers: { 'content-type': 'image/jpeg' } });

/** A fake network: `src` answers the resolver call, `r2` the call to the image bucket, `origin` the old path. */
function net({ src = () => resolved(), r2 = () => resized(), origin = () => resized() } = {}) {
	const calls = [];
	const fetch = async (input, init) => {
		const req = typeof input === 'string' ? { url: input } : input;
		const url = String(req.url ?? input);
		calls.push({ url, init, headers: Object.fromEntries(new Headers(init?.headers ?? req.headers ?? {})) });
		if (url.startsWith(IMAGES)) return r2();
		if (url.endsWith('/src')) {
			const r = src();
			if (r instanceof Error) throw r;
			return r;
		}
		return origin();
	};
	return { calls, deps: { fetch, cache: fakeCache(), now: () => 1_000_000 } };
}
const get = (url, headers = {}) => new Request(url, { headers });
const run = async (req, env, deps) => {
	const c = ctx();
	const res = await handle(req, env, c, deps);
	const text = await res.clone().text();
	await c.done();
	return { res, text };
};

describe('public image from the image bucket', () => {
	it('asks the origin for the key with the secret, then resizes the file in the bucket', async () => {
		const { calls, deps } = net();
		const { res, text } = await run(get(FILE, { accept: 'image/avif,image/webp,*/*' }), ENV, deps);
		expect(text).toBe('RESIZED');
		expect(calls).toHaveLength(2);
		expect(calls[0].url).toBe(`${FILE}/src`);
		expect(calls[0].headers['x-mb-resolve']).toBe('s3cret');
		expect(calls[1].url).toBe(`${IMAGES}/${KEY}`);
		expect(calls[1].init.cf.image).toEqual({ width: 1600, fit: 'scale-down', format: 'webp', quality: 80, metadata: 'none' });
		expect(res.headers.get('cache-control')).toBe('private, max-age=60');
		expect(deps.cache.m.size).toBe(1);
	});

	it('resizes a thumbnail from the stored thumbnail file, or from the original when there is none', async () => {
		let n = net();
		await run(get(FILE + '?thumb=480x0', { accept: 'image/webp' }), ENV, n.deps);
		expect(n.calls[1].url).toBe(`${IMAGES}/${THUMB}`);
		expect(n.calls[1].init.cf.image).toMatchObject({ width: 480, quality: 75, format: 'webp' });
		n = net({ src: () => resolved({ key: KEY, thumb: '' }) });
		await run(get(FILE + '?thumb=480x0', { accept: 'image/webp' }), ENV, n.deps);
		expect(n.calls[1].url).toBe(`${IMAGES}/${KEY}`);
	});

	it('chooses WebP, or JPEG when the client does not list WebP', async () => {
		const formatFor = async (accept) => {
			const n = net();
			await run(get(FILE, accept === undefined ? {} : { accept }), ENV, n.deps);
			return n.calls[1].init.cf.image.format;
		};
		expect(await formatFor('image/avif,image/webp')).toBe('webp');
		expect(await formatFor(undefined)).toBe('webp');
		expect(await formatFor('image/jpeg')).toBe('jpeg');
		expect(await formatFor('image/*;q=0.8')).toBe('jpeg');
	});

	it('answers 404 and caches nothing when the board is private or the image unknown (the old route confirms it)', async () => {
		const n = net({ src: () => new Response('{"message":"x"}', { status: 404 }), origin: () => new Response('{"message":"x"}', { status: 404 }) });
		const { res } = await run(get(FILE), ENV, n.deps);
		expect(res.status).toBe(404);
		expect(n.calls.map((c) => c.url)).toEqual([`${FILE}/src`, FILE]);
		expect(n.deps.cache.m.size).toBe(0);
	});

	it('still serves a public image when the resolver answers 404 (secret not set or not equal on the backend)', async () => {
		const n = net({ src: () => new Response('{"message":"x"}', { status: 404 }), origin: () => resized() });
		const { res, text } = await run(get(FILE, { accept: 'image/webp' }), ENV, n.deps);
		expect(res.status).toBe(200);
		expect(text).toBe('RESIZED');
		expect(n.calls.at(-1).url).toBe(FILE);
	});

	it('never shows the key to the visitor', async () => {
		const { deps } = net();
		const { res, text } = await run(get(FILE, { accept: 'image/webp' }), ENV, deps);
		expect(text).not.toContain('mbinspirations');
		for (const [k, v] of res.headers) expect(`${k}: ${v}`).not.toContain('mbinspirations');
	});

	const FALLBACKS = {
		'the resolver answers with an error': { src: () => new Response('down', { status: 502 }) },
		'the resolver fails': { src: () => new Error('network') },
		'the resolver answers something that is not JSON': { src: () => new Response('<html>', { status: 200 }) },
		'the resolver names a file outside the image folder': { src: () => resolved({ key: '../etc/passwd', thumb: '' }) },
		'the resolver gives no key': { src: () => resolved({}) },
		'the bucket answers with an error': { r2: () => new Response('no', { status: 500 }) },
		'the bucket answers with something that is not an image': { r2: () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html', 'cf-resized': 'internal=ok/h' } }) },
		'the resizer did not run (no cf-resized): that would be the raw original': {
			r2: () => new Response('RAW', { status: 200, headers: { 'content-type': 'image/png' } })
		},
		'the resizer reports an error': { r2: () => new Response('RAW', { status: 200, headers: { 'content-type': 'image/png', 'cf-resized': 'err=9422' } }) }
	};
	for (const [name, setupArgs] of Object.entries(FALLBACKS)) {
		it(`falls back to the old path (origin, then resize) when ${name}`, async () => {
			const n = net({ ...setupArgs, origin: () => resized() });
			const { text } = await run(get(FILE, { accept: 'image/webp' }), ENV, n.deps);
			expect(text).toBe('RESIZED');
			expect(text).not.toBe('RAW');
			const last = n.calls.at(-1);
			expect(last.url).toBe(FILE);
			expect(last.init.cf.image.width).toBe(1600);
		});
	}

	it('uses the old path when no secret or no bucket address is configured', async () => {
		for (const env of [{ ORIGIN, IMAGES }, { ORIGIN, RESOLVE_SECRET: 's3cret' }, { ORIGIN }]) {
			const n = net();
			await run(get(FILE, { accept: 'image/webp' }), env, n.deps);
			expect(n.calls).toHaveLength(1);
			expect(n.calls[0].url).toBe(FILE);
		}
	});

	it('does not wait forever for the resolver', async () => {
		let signal;
		const calls = [];
		const deps = {
			cache: fakeCache(),
			now: () => 1_000_000,
			fetch: async (input, init) => {
				const url = String(input.url ?? input);
				calls.push(url);
				if (url.endsWith('/src')) {
					signal = init.signal;
					return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
				}
				return resized();
			}
		};
		const { text } = await run(get(FILE, { accept: 'image/webp' }), ENV, deps);
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(text).toBe('RESIZED');
		expect(calls.at(-1)).toBe(FILE);
	}, 5000);

	it('does not pass a visitor-sent secret header on to the origin', async () => {
		const n = net({ origin: () => plain() });
		await run(get(`${ORIGIN}/api/mb/public/proj1/files/ins1/src`, { 'x-mb-resolve': 'guess' }), ENV, n.deps);
		await run(get(`${ORIGIN}/api/mb/public/proj1`, { 'x-mb-resolve': 'guess' }), ENV, n.deps);
		for (const c of n.calls) expect(c.headers['x-mb-resolve']).toBeUndefined();
	});
});
