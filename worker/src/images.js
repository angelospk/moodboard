// Moodboard private images. Sits in front of the R2 bucket's custom domain (images.haroldpoi.dev).
//
// The app asks for GET /mbinspirations/<record>/<file>?w=480 (a card thumbnail) or ?w=2048 (the
// image in the panel and the viewer). Cloudflare resizes the stored file (cf.image), picks AVIF,
// WebP or JPEG from the Accept header, and drops metadata. The browser and the edge keep the result
// for a year: the path holds a random file name, so a file never changes under the same URL.
// If resizing is not possible (quota used up, unsupported file, error), the stored file is served
// as it is. A request without ?w, or for any other path, goes to R2 unchanged.

/** Does the Accept header name this media type itself, with q above 0? A wildcard (image/*, a
 *  Safari header that also matches AVIF) does not count: only a named type proves support. */
function listed(accept, type) {
	return accept.split(',').some((part) => {
		const [range, ...params] = part.trim().toLowerCase().split(';').map((x) => x.trim());
		const q = params.find((p) => p.startsWith('q='));
		return range === type && (q === undefined || Number.parseFloat(q.slice(2)) > 0);
	});
}

/** The output format for an Accept header. Cloudflare's format 'auto' keeps a PNG source as PNG
 *  (measured: 125 KB instead of 8 KB), so the format is chosen here. A missing header gets WebP.
 *  `avif: false` never picks AVIF (the public images use WebP: it encodes faster on a cold request). */
export function pickFormat(accept, { avif = true } = {}) {
	if (!accept) return 'webp';
	if (avif && listed(accept, 'image/avif')) return 'avif';
	return listed(accept, 'image/webp') ? 'webp' : 'jpeg';
}

const FILE_PATH = /^\/mbinspirations\/[a-z0-9]+\/[^/]+$/;
/** Sizes the app may ask for, and the quality of each. Any other ?w passes through unchanged. */
export const SIZES = { 480: 75, 2048: 82 };

/** The size to make, or null when this request is not a resize request. */
export function parseTarget(url) {
	if (!FILE_PATH.test(url.pathname)) return null;
	const w = url.searchParams.get('w');
	return w !== null && Object.hasOwn(SIZES, w) ? { width: Number(w), quality: SIZES[w] } : null;
}

const CACHE = 'public, max-age=31536000, immutable';

export async function handle(request, { fetch }) {
	const url = new URL(request.url);
	const target = request.method === 'GET' ? parseTarget(url) : null;
	// A request from the resizer itself must reach R2 as it is (no loop).
	if (!target || /image-resizing/.test(request.headers.get('via') || '')) return fetch(request);

	const origin = new URL(url);
	origin.search = '';
	const accept = request.headers.get('accept') || '*/*';
	const format = pickFormat(request.headers.get('accept'));
	let res = null;
	try {
		res = await fetch(origin, {
			headers: { accept },
			cf: { image: { width: target.width, fit: 'scale-down', format, quality: target.quality, metadata: 'none' } }
		});
	} catch {
		// e.g. the free transformation quota is used up: fall through to the stored file
	}
	const type = res?.headers.get('content-type') || '';
	if (res && res.status === 404) return res;
	if (!res || !res.ok || !type.startsWith('image/')) return fetch(origin, { headers: { accept } });
	const headers = new Headers(res.headers);
	headers.set('cache-control', CACHE);
	headers.set('vary', 'Accept');
	headers.set('access-control-allow-origin', '*');
	return new Response(res.body, { status: 200, headers });
}

export default {
	fetch(request) {
		return handle(request, { fetch: (input, init) => fetch(input, init) });
	}
};
