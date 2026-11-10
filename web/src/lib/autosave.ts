// One autosave engine for every editor (panel and full page), so the save rules live in one tested place.
// Rules: values are captured when they are set (later mutation of the source does not leak in), only
// changed keys are sent, saves run one at a time in order, a failed save keeps its edits for a retry,
// and flush() tells the caller whether everything is stored (so close/navigation can wait for it).

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

/** Deep copy that also reads through Svelte $state proxies (structuredClone cannot). */
function copy<T>(v: T): T {
	return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export class Autosaver<F extends Record<string, unknown>> {
	state: SaveState = 'idle';
	error = '';

	#pending = new Map<string, Partial<F>>();
	#inflight = new Map<string, Set<keyof F>>();
	#failed = new Set<string>();
	#queue: Promise<void> = Promise.resolve();
	#active = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private save: (id: string, fields: Partial<F>) => Promise<unknown>,
		private delay = 700,
		private onstate?: (state: SaveState, error: string) => void
	) {}

	/** Record a new value for one field of one item and schedule a save. */
	set<K extends keyof F>(id: string, key: K, value: F[K]) {
		const p: Partial<F> = this.#pending.get(id) ?? {};
		p[key] = copy(value);
		this.#pending.set(id, p);
		if (this.state !== 'saving') this.#emit('pending');
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => void this.flush(), this.delay);
	}

	/** Send everything pending now. Resolves true when nothing is left unsaved or failed. */
	flush(): Promise<boolean> {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		const batch = [...this.#pending];
		this.#pending.clear();
		for (const [id, fields] of batch) {
			this.#active++;
			this.#queue = this.#queue.then(() => this.#send(id, fields));
		}
		return this.#queue.then(() => this.#failed.size === 0 && this.#pending.size === 0);
	}

	/** Try the failed saves again (with any newer edits merged in). */
	retry(): Promise<boolean> {
		this.#failed.clear();
		this.error = '';
		return this.flush();
	}

	/** Fields of `id` that are not stored yet (pending or being sent). */
	dirtyKeys(id: string): Set<keyof F> {
		const keys = new Set<keyof F>(Object.keys(this.#pending.get(id) ?? {}) as (keyof F)[]);
		for (const k of this.#inflight.get(id) ?? []) keys.add(k);
		return keys;
	}

	/** Forget unsaved edits of an item (e.g. it was deleted). */
	discard(id: string) {
		this.#pending.delete(id);
		this.#failed.delete(id);
	}

	async #send(id: string, fields: Partial<F>) {
		this.#inflight.set(id, new Set(Object.keys(fields) as (keyof F)[]));
		this.#emit('saving');
		try {
			await this.save(id, fields);
			this.#failed.delete(id);
		} catch (e) {
			// Keep the edits; anything set since then is newer and wins.
			this.#pending.set(id, { ...fields, ...(this.#pending.get(id) ?? {}) });
			this.#failed.add(id);
			this.error = e instanceof Error ? e.message : String(e);
		} finally {
			this.#inflight.delete(id);
			this.#active--;
			if (this.#active === 0) {
				this.#emit(this.#failed.size ? 'error' : this.#pending.size ? 'pending' : 'saved');
			}
		}
	}

	#emit(s: SaveState) {
		if (s === this.state) return;
		this.state = s;
		if (s !== 'error') this.error = s === 'pending' || s === 'saving' ? this.error : '';
		this.onstate?.(s, this.error);
	}
}
