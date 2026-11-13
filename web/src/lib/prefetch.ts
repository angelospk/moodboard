// Warms the images the viewer will show next, so the arrow keys feel instant.
// It holds the decoded images in memory: the public Worker lets the browser keep a file only for the
// seconds that are left of its 60 s edge cache, so the HTTP cache alone would lose a prefetch quickly.

/** What Prefetcher needs of an <img> (a plain object in the tests). */
export interface ImgLike {
	src: string;
	onload: ((ev: Event) => void) | null;
	onerror: ((ev: Event) => void) | null;
	decode?: () => Promise<void>;
	decoding?: string;
	fetchPriority?: string;
}

const saveData = () => (globalThis.navigator as { connection?: { saveData?: boolean } } | undefined)?.connection?.saveData === true;

/** The urls to warm around position `index`: next, previous, then the second next. */
export function neighborUrls<T>(list: T[], index: number, urlOf: (item: T) => string | null): string[] {
	if (index < 0 || index >= list.length) return [];
	return [index + 1, index - 1, index + 2]
		.map((i) => (list[i] === undefined ? null : urlOf(list[i])))
		.filter((u): u is string => !!u);
}

export class Prefetcher {
	private held = new Map<string, ImgLike>();
	private queue: string[] = [];
	private active: string | null = null;

	constructor(
		private max = 5,
		private make: () => ImgLike = () => new Image(),
		private skip: () => boolean = saveData
	) {}

	/** The images wanted now, most urgent first. A download for an image that is no longer wanted stops. */
	warm(urls: (string | null | undefined)[]): void {
		if (this.skip()) return;
		const want = [...new Set(urls.filter((u): u is string => !!u))].slice(0, this.max);
		for (const [url, img] of [...this.held]) {
			if (want.includes(url)) continue;
			this.release(img);
			this.held.delete(url);
			if (this.active === url) this.active = null;
		}
		this.queue = want.filter((u) => !this.held.has(u));
		this.pump();
	}

	/** Abort everything and forget it. */
	stop(): void {
		for (const img of this.held.values()) this.release(img);
		this.held.clear();
		this.queue = [];
		this.active = null;
	}

	private release(img: ImgLike) {
		img.onload = null;
		img.onerror = null;
		img.src = '';
	}

	private pump() {
		if (this.active) return;
		const url = this.queue.shift();
		if (!url) return;
		const img = this.make();
		const done = (ok: boolean) => {
			if (this.held.get(url) !== img) return; // released while it downloaded
			this.active = null;
			if (ok) void img.decode?.().catch(() => {});
			else this.held.delete(url);
			this.pump();
		};
		img.onload = () => done(true);
		img.onerror = () => done(false);
		img.decoding = 'async';
		img.fetchPriority = 'low';
		this.held.set(url, img);
		this.active = url;
		img.src = url;
	}
}
