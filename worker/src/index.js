// Moodboard public images. Sits in front of GET /api/mb/public/{project}/files/{id} on the API host.
//
// Public board images were read from the image bucket by the small VPS, cleaned in its memory and
// sent through the tunnel for every viewer. This Worker lets Cloudflare do it:
//   - it asks the VPS once per image and size (the VPS still decides public/private: a 404 passes
//     through and is never cached),
//   - Cloudflare resizes the image (cf.image) to 1600 px (480 px for ?thumb=480x0), converts it to
//     AVIF/WebP when the client accepts it, and drops all metadata (GPS, camera) in the same step,
//   - the result is kept at the edge for TTL seconds, and a browser gets only the freshness that is
//     left, so turning a board private takes effect within about TTL seconds. Cloudflare documents a
//     one-hour minimum for its own cache of resized images; the VPS answer is "private", which keeps
//     Cloudflare from storing it, and a real probe (board made private, polled) gave 404 after 51 s.
//     If that ever changes, add must-revalidate (and an ETag) to the VPS answer.
// If resizing fails, the plain VPS answer is served (it strips metadata too).
// The board JSON itself (GET /api/mb/public/{project}, no query string) is kept at the edge the same
// way: stored for TTL seconds, a browser gets the freshness that is left, and only a 2xx answer is
// stored. So TTL also bounds how long a board stays visible after it is made private or edited.
// Every other request goes to the VPS unchanged.
//
// Old copies stand in (stale while revalidate): a copy older than TTL but younger than STALE is served
// at once (the browser gets max-age=0, so it asks again), and a refresh runs in the background: a
// 200 replaces the copy, a 404 deletes it (the board went private), another error keeps it but marks it
// as served: the next request asks the origin itself. So after a board is turned private an edge location
// shows it at most for the requests that arrive while that one refresh runs (about a second), only when
// a copy younger than STALE exists. Past STALE the origin is asked first, as before.
//
// Cold images do not cross the home connection. On a miss the Worker asks the origin only for the
// storage key (GET .../files/{id}/src, guarded by RESOLVE_SECRET; the origin checks public/private
// there), then resizes the file straight from the image bucket (IMAGES, the R2 custom domain). The
// key is the way to the original, which still holds GPS and camera data, so it never reaches the
// visitor, and the raw bucket file is never served: if the resizer did not run (no cf-resized header)
// the old path below is used. Without RESOLVE_SECRET or IMAGES, or when anything fails, the old
// path (origin streams the cleaned file, then Cloudflare resizes it) answers.

import { pickFormat } from './images.js';

export const TTL = 60;
/** How long past TTL an old copy may still be served once, while a fresh one is fetched in the background. */
export const STALE = 3600;
const RESOLVE_TIMEOUT_MS = 1500;
const KEY = /^mbinspirations\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;
const FILE_PATH = /^\/api\/mb\/public\/[^/]+\/files\/[^/]+$/;
const BOARD_PATH = /^\/api\/mb\/public\/[^/]+$/;

/** The size to serve, or null when this request is not a public image. */
export function parseTarget(url) {
	if (!FILE_PATH.test(url.pathname)) return null;
	const thumb = url.searchParams.get('thumb');
	if (thumb === null) return { width: 1600 };
	return thumb === '480x0' ? { width: 480 } : null;
}

/** Does an Accept header allow this media type? A missing header allows everything; q=0 forbids. */
export function acceptsType(accept, type) {
	if (!accept) return true;
	const [major] = type.split('/');
	let best = null; // [specificity, q]
	for (const part of accept.split(',')) {
		const [range, ...params] = part.trim().split(';').map((x) => x.trim());
		let q = 1;
		for (const p of params) if (/^q=/i.test(p)) q = Number.parseFloat(p.slice(2));
		if (!(q >= 0)) q = 0;
		const r = range.toLowerCase();
		const spec = r === type ? 3 : r === `${major}/*` ? 2 : r === '*/*' ? 1 : 0;
		if (spec && (!best || spec > best[0])) best = [spec, q];
	}
	return !!best && best[1] > 0;
}

/** What the browser gets: it may keep the file for the time that is left, a shared cache may not. */
function forBrowser(body, contentType, maxAge) {
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': contentType || 'application/octet-stream',
			'cache-control': `private, max-age=${maxAge}`,
			vary: 'Accept',
			'access-control-allow-origin': '*'
		}
	});
}

/** The board JSON: the VPS answer's content type is kept, the browser gets the time that is left. */
function boardForBrowser(body, contentType, maxAge) {
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': contentType || 'application/json',
			'cache-control': `private, max-age=${maxAge}`,
			'access-control-allow-origin': '*'
		}
	});
}

/** A copy that was already served stale carries this header: the next request asks the origin itself. */
const SERVED = 'x-stale-served';
const unserved = (hit) => !hit.headers.has(SERVED);
function served(copy) {
	const headers = new Headers(copy.headers);
	headers.set(SERVED, '1');
	return new Response(copy.body, { status: 200, headers });
}

/** Write the marker; a failure must not stop the refresh that follows it. */
const markServed = (cache, key, copy) => cache.put(key, served(copy)).catch(() => {});

const ageOf = (hit, now) => Math.floor((now() - Number(hit.headers.get('x-stored-at'))) / 1000);

/** The refreshes running in this isolate, by cache key: many visitors of one old copy start one fetch. */
const refreshing = new Set();
function refresh(key, ctx, job) {
	if (refreshing.has(key.url)) return;
	refreshing.add(key.url);
	ctx.waitUntil(job().catch(() => {}).finally(() => refreshing.delete(key.url)));
}

/** The request for the origin: the visitor's request, without the secret header (it is ours alone). */
function toOrigin(originUrl, request) {
	const req = new Request(originUrl, request);
	req.headers.delete('x-mb-resolve');
	return req;
}

/** Where an image is stored, asked of the origin with the shared secret. Null means "not available, use
 *  the old path": no secret, an error, a timeout, and also the resolver's 404, which is the same answer
 *  for a private board and for a backend whose secret differs. The old path asks the origin again and
 *  settles it (it answers 404 for a private board, the file for a public one). */
async function resolveKey(env, pathname, fetch) {
	if (!env.RESOLVE_SECRET || !env.IMAGES) return null;
	let res;
	try {
		res = await fetch(`${env.ORIGIN}${pathname}/src`, {
			headers: { 'x-mb-resolve': env.RESOLVE_SECRET },
			signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
		});
	} catch {
		return null;
	}
	if (!res.ok) return null;
	try {
		const { key, thumb } = await res.json();
		if (typeof key !== 'string' || !KEY.test(key) || key.includes('..')) return null;
		return { key, thumb: typeof thumb === 'string' && KEY.test(thumb) && !thumb.includes('..') ? thumb : '' };
	} catch {
		return null;
	}
}

/** Resize the stored file in the image bucket. Null unless the resizer really ran and returned an image
 *  this client can decode (otherwise the answer could be the raw original). */
async function resizeFromBucket(env, where, target, accept, fetch) {
	const src = target.width === 480 && where.thumb ? where.thumb : where.key;
	let res;
	try {
		res = await fetch(`${env.IMAGES}/${src.split('/').map(encodeURIComponent).join('/')}`, {
			headers: { accept: accept || '*/*' },
			cf: {
				image: {
					width: target.width,
					fit: 'scale-down',
					format: pickFormat(accept, { avif: false }),
					quality: target.width === 480 ? 75 : 80,
					metadata: 'none'
				}
			}
		});
	} catch {
		return null;
	}
	const type = res.headers.get('content-type') || '';
	if (!res.ok || !/internal=ok/.test(res.headers.get('cf-resized') || '') || !type.startsWith('image/') || !acceptsType(accept, type)) return null;
	return res;
}

/** Store a 200 answer under key, with the time it was stored. The Cache API drops an entry when its
 *  max-age ends (measured: the copy was gone at 60 s), so max-age is STALE here; ageOf() and TTL decide
 *  what is still fresh. */
function store(cache, key, body, type, now) {
	return cache.put(
		key,
		new Response(body, { status: 200, headers: { 'content-type': type, 'cache-control': `public, max-age=${STALE}`, 'x-stored-at': String(now()) } })
	);
}

async function handleBoard(request, originUrl, key, ctx, { fetch, cache, now }) {
	const get = () => fetch(toOrigin(originUrl, request));
	const hit = await cache.match(key);
	if (hit) {
		const age = ageOf(hit, now);
		const type = hit.headers.get('content-type');
		if (age < TTL) return boardForBrowser(hit.body, type, TTL - age);
		if (age < STALE && unserved(hit)) {
			const copy = hit.clone();
			refresh(key, ctx, async () => {
				await markServed(cache, key, copy);
				const res = await get();
				if (res.status === 200) await store(cache, key, res.body, res.headers.get('content-type') || 'application/json', now);
				else if (res.status === 404) await cache.delete(key);
			});
			return boardForBrowser(hit.body, type, 0);
		}
	}
	const res = await get();
	if (res.status !== 200) return res; // private, unknown or failing: as the VPS said, never stored
	const type = res.headers.get('content-type') || 'application/json';
	ctx.waitUntil(store(cache, key, res.clone().body, type, now));
	return boardForBrowser(res.body, type, TTL);
}

export async function handle(request, env, ctx, { fetch, cache, now = Date.now }) {
	const url = new URL(request.url);
	// Always the configured API host, never a host taken from the request.
	const originUrl = env.ORIGIN + url.pathname + url.search;
	if (request.method === 'GET' && !url.search && BOARD_PATH.test(url.pathname)) {
		return handleBoard(request, originUrl, new Request(`${env.ORIGIN}${url.pathname}`), ctx, { fetch, cache, now });
	}
	const target = request.method === 'GET' ? parseTarget(url) : null;
	// A request from the resizer itself must reach the VPS as it is (no loop).
	if (!target || /image-resizing/.test(request.headers.get('via') || '')) {
		return fetch(toOrigin(originUrl, request));
	}

	const accept = request.headers.get('accept');
	const key = new Request(`${env.ORIGIN}${url.pathname}?w=${target.width}`);
	const hit = await cache.match(key);
	if (hit) {
		const age = ageOf(hit, now);
		const type = hit.headers.get('content-type');
		if (age < TTL) {
			if (acceptsType(accept, type)) return forBrowser(hit.body, type, TTL - age);
			return fetch(originUrl); // stored type is not decodable by this client: plain file
		}
		if (age < STALE && unserved(hit) && acceptsType(accept, type)) {
			const copy = hit.clone();
			refresh(key, ctx, async () => {
				await markServed(cache, key, copy);
				const out = await render(env, url, originUrl, target, accept, fetch);
				if (out.gone) await cache.delete(key);
				else if (usable(out.res, accept)) await store(cache, key, out.res.body, out.res.headers.get('content-type') || 'application/octet-stream', now);
			});
			return forBrowser(hit.body, type, 0);
		}
	}

	const out = await render(env, url, originUrl, target, accept, fetch);
	if (out.gone) return out.gone; // private or unknown: never cached, no retry
	const res = out.res;
	if (!res || !res.ok) return fetch(originUrl); // the resizer failed: serve the plain (stripped) file
	if (!usable(res, accept)) return fetch(originUrl);
	const type = res.headers.get('content-type') || 'application/octet-stream';
	ctx.waitUntil(store(cache, key, res.clone().body, type, now));
	return forBrowser(res.body, type, TTL);
}

/** Is this a copy worth storing: a 200 image the client can decode? */
function usable(res, accept) {
	return !!res && res.ok && acceptsType(accept, res.headers.get('content-type') || 'application/octet-stream');
}

/** Make one resized copy. {gone} is the origin's 404 (private or unknown); {res} may be null when no
 *  resizer answered. The bucket first, then the old path (origin streams the cleaned file). */
async function render(env, url, originUrl, target, accept, fetch) {
	const where = await resolveKey(env, url.pathname, fetch);
	let res = where ? await resizeFromBucket(env, where, target, accept, fetch) : null;
	if (!res) {
		try {
			// The format comes from the Accept header (see pickFormat): Cloudflare's "auto" keeps a PNG as PNG.
			res = await fetch(originUrl, {
				headers: { accept: accept || '*/*' },
				cf: { image: { width: target.width, fit: 'scale-down', format: pickFormat(accept), quality: 85, metadata: 'none' } }
			});
		} catch {
			// e.g. the free transformation quota is used up: fall through to the plain file
		}
	}
	if (res && res.status === 404) return { gone: res };
	return { res };
}

export default {
	fetch(request, env, ctx) {
		return handle(request, env, ctx, { fetch: (input, init) => fetch(input, init), cache: caches.default });
	}
};
