import { describe, expect, it } from 'vitest';
import { Prefetcher, neighborUrls } from '../src/lib/prefetch';

/** A fake image: setting src "starts a download"; the test finishes it by hand. */
function fakes() {
	const made: { src: string; onload: (() => void) | null; onerror: (() => void) | null; decoded: number }[] = [];
	const make = () => {
		const img = {
			src: '',
			onload: null as (() => void) | null,
			onerror: null as (() => void) | null,
			decoded: 0,
			decode() {
				img.decoded++;
				return Promise.resolve();
			}
		};
		made.push(img);
		return img;
	};
	const started = () => made.filter((i) => i.src !== '').map((i) => i.src);
	return { made, make, started };
}

describe('neighborUrls', () => {
	const list = ['a', 'b', 'c', 'd', 'e'];
	const urlOf = (s: string) => `u:${s}`;
	it('lists next, previous, then the second next', () => {
		expect(neighborUrls(list, 2, urlOf)).toEqual(['u:d', 'u:b', 'u:e']);
	});
	it('skips what is past either end', () => {
		expect(neighborUrls(list, 0, urlOf)).toEqual(['u:b', 'u:c']);
		expect(neighborUrls(list, 4, urlOf)).toEqual(['u:d']);
		expect(neighborUrls(list, -1, urlOf)).toEqual([]);
		expect(neighborUrls([], 0, urlOf)).toEqual([]);
	});
	it('skips an item without a url', () => {
		expect(neighborUrls(list, 2, (s) => (s === 'd' ? null : `u:${s}`))).toEqual(['u:b', 'u:e']);
	});
});

describe('Prefetcher', () => {
	it('downloads one image at a time, in the given order', () => {
		const f = fakes();
		const p = new Prefetcher(5, f.make);
		p.warm(['n', 'p', 'n2']);
		expect(f.started()).toEqual(['n']);
		f.made[0].onload!();
		expect(f.started()).toEqual(['n', 'p']);
		f.made[1].onload!();
		expect(f.started()).toEqual(['n', 'p', 'n2']);
	});

	it('pre-decodes an image when it has loaded', () => {
		const f = fakes();
		const p = new Prefetcher(5, f.make);
		p.warm(['n']);
		f.made[0].onload!();
		expect(f.made[0].decoded).toBe(1);
	});

	it('does not fetch an image it already holds', () => {
		const f = fakes();
		const p = new Prefetcher(5, f.make);
		p.warm(['n', 'p']);
		f.made[0].onload!();
		f.made[1].onload!();
		p.warm(['n', 'p']);
		expect(f.made).toHaveLength(2);
	});

	it('stops what is no longer wanted: the visitor moved on', () => {
		const f = fakes();
		const p = new Prefetcher(5, f.make);
		p.warm(['n', 'p']);
		p.warm(['x', 'y']); // n is still downloading, p never started
		expect(f.made[0].src).toBe(''); // the download of n was aborted
		expect(f.started()).toEqual(['x']);
		f.made[1].onload!();
		expect(f.started()).toEqual(['x', 'y']);
	});

	it('an aborted image that fires its load event late does not start the next one twice', () => {
		const f = fakes();
		const p = new Prefetcher(5, f.make);
		p.warm(['n']);
		const old = f.made[0];
		p.warm(['x']);
		old.onload?.();
		expect(f.started()).toEqual(['x']);
	});

	it('forgets a failed image so a later warm tries again, and goes on with the queue', () => {
		const f = fakes();
		const p = new Prefetcher(5, f.make);
		p.warm(['n', 'p']);
		f.made[0].onerror!();
		expect(f.started()).toEqual(['n', 'p']);
		f.made[1].onload!();
		p.warm(['n', 'p']);
		expect(f.started()).toEqual(['n', 'p', 'n']);
	});

	it('keeps at most max images', () => {
		const f = fakes();
		const p = new Prefetcher(2, f.make);
		p.warm(['a', 'b', 'c']);
		f.made[0].onload!();
		f.made[1].onload!();
		expect(f.started()).toEqual(['a', 'b']);
	});

	it('stop() aborts everything and ignores late events', () => {
		const f = fakes();
		const p = new Prefetcher(5, f.make);
		p.warm(['n', 'p']);
		const first = f.made[0];
		p.stop();
		expect(first.src).toBe('');
		first.onload?.();
		expect(f.made).toHaveLength(1);
	});

	it('does nothing when the visitor asked to save data', () => {
		const f = fakes();
		const p = new Prefetcher(5, f.make, () => true);
		p.warm(['n']);
		expect(f.made).toHaveLength(0);
	});
});
