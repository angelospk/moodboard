import { describe, expect, it } from 'vitest';
import { cdnFor, imageUrl, imageUrls, thumbUrl } from '../src/lib/inspirations';

const CDN = 'https://images.example.dev';
const row = { id: 'rec123abc456def', image_path: 'photo_ab12cd34ef.png' };

describe('image CDN urls', () => {
	it('points at the CDN with the stored file path, without a token', () => {
		const pb = {} as never;
		expect(imageUrl(pb, row, 'tok', CDN)).toBe(`${CDN}/mbinspirations/rec123abc456def/photo_ab12cd34ef.png?w=2048`);
	});

	it('keeps the API url when no CDN is set', () => {
		const pb = { files: { getURL: (_r: unknown, name: string, q: { token: string }) => `https://api/x/${name}?token=${q.token}` } } as never;
		expect(imageUrl(pb, row, 'tok', '')).toBe('https://api/x/photo_ab12cd34ef.png?token=tok');
	});

	it('thumbUrl asks the CDN for a 480 px copy', () => {
		const url = `${CDN}/mbinspirations/rec123abc456def/photo_ab12cd34ef.png?w=2048`;
		expect(thumbUrl(url, CDN)).toBe(`${CDN}/mbinspirations/rec123abc456def/photo_ab12cd34ef.png?w=480`);
	});

	it('thumbUrl still adds ?thumb for API urls and leaves blob urls alone', () => {
		expect(thumbUrl('https://api/files/x/y/z.png?token=t', CDN)).toBe('https://api/files/x/y/z.png?token=t&thumb=480x0');
		expect(thumbUrl('blob:http://x/1', CDN)).toBe('blob:http://x/1');
		expect(thumbUrl(null, CDN)).toBeNull();
	});

	it('uses the CDN only for the production API', () => {
		expect(cdnFor({ baseURL: 'https://moodboard-api.haroldpoi.dev' })).toBe('https://images.haroldpoi.dev');
		expect(cdnFor({ baseURL: 'http://127.0.0.1:18190' })).toBe('');
	});

	it('imageUrls builds CDN urls without asking for a file token', async () => {
		const pb = {
			baseURL: 'https://moodboard-api.haroldpoi.dev',
			files: { getToken: () => Promise.reject(new Error('token endpoint down')) }
		} as never;
		const urls = await imageUrls(pb, [{ id: 'r1', image_path: 'a.png' } as never]);
		expect(urls['a.png']).toBe('https://images.haroldpoi.dev/mbinspirations/r1/a.png?w=2048');
	});
});
