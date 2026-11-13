import { describe, expect, it } from 'vitest';
import { handle, parseTarget } from '../src/images.js';

const FILE = 'https://images.haroldpoi.dev/mbinspirations/rec1abc/image_x1.png';
const get = (url, headers = {}) => new Request(url, { headers });
const img = (type = 'image/avif') => new Response('IMG', { status: 200, headers: { 'content-type': type } });

function setup(...responses) {
	const calls = [];
	const queue = [...responses];
	const fetch = async (input, init) => {
		calls.push({ url: String(input.url ?? input), init });
		const next = queue.length > 1 ? queue.shift() : queue[0];
		if (next instanceof Error) throw next;
		return next.clone();
	};
	return { calls, deps: { fetch } };
}

describe('parseTarget', () => {
	it('knows the allowed sizes of a stored image', () => {
		expect(parseTarget(new URL(FILE + '?w=480'))).toEqual({ width: 480, quality: 75 });
		expect(parseTarget(new URL(FILE + '?w=2048'))).toEqual({ width: 2048, quality: 82 });
	});
	it('ignores other sizes, other paths and thumbs_ files', () => {
		expect(parseTarget(new URL(FILE))).toBeNull();
		expect(parseTarget(new URL(FILE + '?w=99999'))).toBeNull();
		expect(parseTarget(new URL(FILE + '?w=toString'))).toBeNull();
		expect(parseTarget(new URL('https://images.haroldpoi.dev/other/a/b.png?w=480'))).toBeNull();
		expect(parseTarget(new URL('https://images.haroldpoi.dev/mbinspirations/rec1/thumbs_a/480x0_a?w=480'))).toBeNull();
	});
});

describe('handle', () => {
	it('resizes with AVIF/WebP chosen by Accept and keeps the result for a year', async () => {
		const { calls, deps } = setup(img());
		const res = await handle(get(FILE + '?w=480', { accept: 'image/avif,image/webp,*/*' }), deps);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(res.headers.get('vary')).toBe('Accept');
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(FILE);
		expect(calls[0].init.headers.accept).toBe('image/avif,image/webp,*/*');
		expect(calls[0].init.cf.image).toEqual({ width: 480, fit: 'scale-down', format: 'avif', quality: 75, metadata: 'none' });
	});
	it('picks the best format the client accepts', async () => {
		const formatFor = async (accept) => {
			const { calls, deps } = setup(img());
			await handle(get(FILE + '?w=480', accept === undefined ? {} : { accept }), deps);
			return calls[0].init.cf.image.format;
		};
		expect(await formatFor('image/webp,image/png,*/*;q=0.8')).toBe('webp');
		expect(await formatFor('image/*;q=0.8,*/*;q=0.5')).toBe('jpeg');
		expect(await formatFor('image/jpeg')).toBe('jpeg');
		expect(await formatFor('image/avif;q=0,image/webp')).toBe('webp');
		expect(await formatFor(undefined)).toBe('webp');
	});
	it('passes a request without a size to R2 unchanged', async () => {
		const { calls, deps } = setup(img('image/png'));
		const req = get(FILE);
		await handle(req, deps);
		expect(calls).toHaveLength(1);
		expect(calls[0].init).toBeUndefined();
	});
	it('does not resize its own subrequest (no loop)', async () => {
		const { calls, deps } = setup(img());
		await handle(get(FILE + '?w=480', { via: '1.1 image-resizing' }), deps);
		expect(calls).toHaveLength(1);
		expect(calls[0].init).toBeUndefined();
	});
	it('serves the stored file when resizing throws or answers a non-image', async () => {
		for (const first of [new Error('quota'), new Response('nope', { status: 502 }), new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })]) {
			const { calls, deps } = setup(first, img('image/png'));
			const res = await handle(get(FILE + '?w=2048'), deps);
			expect(res.status).toBe(200);
			expect(calls).toHaveLength(2);
			expect(calls[1].init.cf).toBeUndefined();
		}
	});
	it('passes a 404 through without a retry', async () => {
		const { calls, deps } = setup(new Response('', { status: 404 }));
		const res = await handle(get(FILE + '?w=480'), deps);
		expect(res.status).toBe(404);
		expect(calls).toHaveLength(1);
	});
});
