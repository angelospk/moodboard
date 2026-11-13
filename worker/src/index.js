// Moodboard public images. Sits in front of GET /api/mb/public/{project}/files/{id} on the API host.
//
// Public board images were read from the image bucket by the small VPS, cleaned in its memory and
// sent through the tunnel for every viewer. This Worker lets Cloudflare do it:
//   - it asks the VPS once per image, size and format (the VPS still decides public/private: a 404
//     passes through and is never cached),
//   - Cloudflare resizes the image (cf.image) to 1600 px (480 px for ?thumb=480x0), converts it to
//     AVIF/WebP and drops all metadata (GPS, camera) in the same step,
//   - the result is kept at the edge for 5 minutes (the same time browsers keep it today, so turning
//     a board private takes effect within 5 minutes).
// If resizing fails, the plain VPS answer is served (it strips metadata too). Every other request
// goes to the VPS unchanged.

const TTL = 300;
const FILE_PATH = /^\/api\/mb\/public\/[^/]+\/files\/[^/]+$/;

/** The size to serve, or null when this request is not a public image. */
export function parseTarget(url) {
	if (!FILE_PATH.test(url.pathname)) return null;
	const thumb = url.searchParams.get('thumb');
	if (thumb === null) return { width: 1600 };
	return thumb === '480x0' ? { width: 480 } : null;
}

export function pickFormat(accept) {
	const a = accept || '';
	if (a.includes('image/avif')) return 'avif';
	if (a.includes('image/webp')) return 'webp';
	return 'jpeg';
}

/** What the browser gets: it may keep the file for 5 minutes, but a shared cache may not. */
function forBrowser(res) {
	return new Response(res.body, {
		status: 200,
		headers: {
			'content-type': res.headers.get('content-type') || 'application/octet-stream',
			'cache-control': `private, max-age=${TTL}`,
			vary: 'Accept',
			'access-control-allow-origin': '*'
		}
	});
}

export async function handle(request, env, ctx, { fetch, cache }) {
	const url = new URL(request.url);
	// Always the configured API host, never a host taken from the request.
	const originUrl = env.ORIGIN + url.pathname + url.search;
	const target = request.method === 'GET' ? parseTarget(url) : null;
	// A request from the resizer itself must reach the VPS as it is (no loop).
	if (!target || /image-resizing/.test(request.headers.get('via') || '')) {
		return fetch(new Request(originUrl, request));
	}

	const format = pickFormat(request.headers.get('accept'));
	const key = new Request(`${env.ORIGIN}${url.pathname}?w=${target.width}&f=${format}`);
	const hit = await cache.match(key);
	if (hit) return forBrowser(hit);

	// format "auto" lets Cloudflare choose AVIF, WebP or JPEG from the Accept header, which we forward.
	const res = await fetch(originUrl, {
		headers: { accept: request.headers.get('accept') || '*/*' },
		cf: { image: { width: target.width, fit: 'scale-down', format: 'auto', quality: 85, metadata: 'none' } }
	});
	if (res.status === 404) return res; // private or unknown: never cached, no retry
	if (!res.ok) return fetch(originUrl); // the resizer failed: serve the plain (stripped) file

	const stored = new Response(res.clone().body, {
		status: 200,
		headers: {
			'content-type': res.headers.get('content-type') || 'application/octet-stream',
			'cache-control': `public, max-age=${TTL}`
		}
	});
	ctx.waitUntil(cache.put(key, stored));
	return forBrowser(res);
}

export default {
	fetch(request, env, ctx) {
		return handle(request, env, ctx, { fetch: (input, init) => fetch(input, init), cache: caches.default });
	}
};
