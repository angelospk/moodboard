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
// If resizing fails, the plain VPS answer is served (it strips metadata too). Every other request
// goes to the VPS unchanged.

export const TTL = 60;
const FILE_PATH = /^\/api\/mb\/public\/[^/]+\/files\/[^/]+$/;

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

export async function handle(request, env, ctx, { fetch, cache, now = Date.now }) {
	const url = new URL(request.url);
	// Always the configured API host, never a host taken from the request.
	const originUrl = env.ORIGIN + url.pathname + url.search;
	const target = request.method === 'GET' ? parseTarget(url) : null;
	// A request from the resizer itself must reach the VPS as it is (no loop).
	if (!target || /image-resizing/.test(request.headers.get('via') || '')) {
		return fetch(new Request(originUrl, request));
	}

	const accept = request.headers.get('accept');
	const key = new Request(`${env.ORIGIN}${url.pathname}?w=${target.width}`);
	const hit = await cache.match(key);
	if (hit) {
		const left = TTL - Math.floor((now() - Number(hit.headers.get('x-stored-at'))) / 1000);
		const type = hit.headers.get('content-type');
		if (left > 0 && acceptsType(accept, type)) return forBrowser(hit.body, type, left);
		if (left > 0) return fetch(originUrl); // stored type is not decodable by this client: plain file
	}

	let res = null;
	try {
		// format "auto" lets Cloudflare choose AVIF, WebP or JPEG from the Accept header, which we forward.
		res = await fetch(originUrl, {
			headers: { accept: accept || '*/*' },
			cf: { image: { width: target.width, fit: 'scale-down', format: 'auto', quality: 85, metadata: 'none' } }
		});
	} catch {
		// e.g. the free transformation quota is used up: fall through to the plain file
	}
	if (res && res.status === 404) return res; // private or unknown: never cached, no retry
	if (!res || !res.ok) return fetch(originUrl); // the resizer failed: serve the plain (stripped) file

	const type = res.headers.get('content-type') || 'application/octet-stream';
	if (!acceptsType(accept, type)) return fetch(originUrl);
	const stored = new Response(res.clone().body, {
		status: 200,
		headers: { 'content-type': type, 'cache-control': `public, max-age=${TTL}`, 'x-stored-at': String(now()) }
	});
	ctx.waitUntil(cache.put(key, stored));
	return forBrowser(res.body, type, TTL);
}

export default {
	fetch(request, env, ctx) {
		return handle(request, env, ctx, { fetch: (input, init) => fetch(input, init), cache: caches.default });
	}
};
