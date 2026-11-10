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
	/** Batches handed to the queue and not finished yet (queued or being sent), oldest first. */
	#outstanding: { id: string; fields: Partial<F> }[] = [];
	#failed = new Set<string>();
	#queue: Promise<void> = Promise.resolve();
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

	/** Send everything pending now. Resolves, once the queue is empty (also of saves queued later),
	 *  true when nothing is left unsaved or failed. */
	async flush(): Promise<boolean> {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		for (const [id, fields] of this.#pending) {
			const job = { id, fields };
			this.#outstanding.push(job);
			this.#queue = this.#queue.then(() => this.#send(job));
		}
		this.#pending.clear();
		let q: Promise<void>;
		do {
			q = this.#queue;
			await q;
		} while (q !== this.#queue);
		return this.#failed.size === 0 && this.#pending.size === 0;
	}

	/** Try the failed saves again (with any newer edits merged in). */
	retry(): Promise<boolean> {
		this.#failed.clear();
		this.error = '';
		return this.flush();
	}

	/** Fields of `id` that are not stored yet (pending, queued or being sent). */
	dirtyKeys(id: string): Set<keyof F> {
		return new Set(Object.keys(this.draft(id)) as (keyof F)[]);
	}

	/** The newest unsaved value of each field of `id` (what an editor should show for it). */
	draft(id: string): Partial<F> {
		const d: Partial<F> = {};
		for (const job of this.#outstanding) if (job.id === id) Object.assign(d, job.fields);
		Object.assign(d, this.#pending.get(id) ?? {});
		return copy(d);
	}

	/** Forget unsaved edits of an item (e.g. it was deleted). */
	discard(id: string) {
		this.#pending.delete(id);
		this.#failed.delete(id);
	}

	async #send(job: { id: string; fields: Partial<F> }) {
		const { id, fields } = job;
		this.#emit('saving');
		try {
			await this.save(id, fields);
			if (!this.#pending.has(id)) this.#failed.delete(id);
		} catch (e) {
			// Keep the edits for a retry, except fields a newer batch or edit already replaced.
			const keep: Partial<F> = { ...fields };
			const later = this.#outstanding.slice(this.#outstanding.indexOf(job) + 1);
			for (const other of [...later.filter((j) => j.id === id).map((j) => j.fields), this.#pending.get(id) ?? {}]) {
				for (const k of Object.keys(other)) delete keep[k as keyof F];
			}
			if (Object.keys(keep).length) this.#pending.set(id, { ...keep, ...(this.#pending.get(id) ?? {}) });
			this.#failed.add(id);
			this.error = e instanceof Error ? e.message : String(e);
		} finally {
			this.#outstanding.splice(this.#outstanding.indexOf(job), 1);
			if (this.#outstanding.length === 0) {
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
