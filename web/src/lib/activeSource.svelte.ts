// «Προσθέτεις από», per browser: the map and /new share it, and other tabs follow it.
import { cleanSourceProject } from '#lib/sourceProjects.js';
import { liveSource, parseActiveSource, sameSource, type ActiveSource } from '#lib/activeSource.js';

const KEY = 'moodboard:active-source';

let stored = $state<ActiveSource | null>(null);
/** Re-read once a minute so a source that lapses leaves the screen. */
let now = $state(Date.now());

/** The last write did not reach storage (full or blocked): this page's copy is the truth. */
let memoryOnly = false;

/** What storage holds now (another tab may have changed it); this page's copy when storage fails. */
function read(): ActiveSource | null {
	if (memoryOnly) return stored;
	try {
		return parseActiveSource(localStorage.getItem(KEY));
	} catch {
		return stored;
	}
}

function write(a: ActiveSource | null) {
	stored = a;
	try {
		if (a) localStorage.setItem(KEY, JSON.stringify(a));
		else localStorage.removeItem(KEY);
		memoryOnly = false;
	} catch {
		// Private mode, full or blocked storage: the source lasts until the page closes.
		memoryOnly = true;
	}
}

export const activeSource = {
	/** The live source (shown on screen), or null. */
	get live(): ActiveSource | null {
		return liveSource(stored, now);
	},
	/** The live source at this moment (for a new image), or null. */
	fresh(): ActiveSource | null {
		stored = read();
		return liveSource(stored, Date.now());
	},
	start(url: string, project: string | null) {
		now = Date.now();
		write({ url, project: cleanSourceProject(project), at: now });
	},
	/** Put back an earlier state (Undo). */
	restore(a: ActiveSource | null) {
		now = Date.now();
		write(a && { ...a, at: now });
	},
	stop() {
		write(null);
	},
	/** Images were added with `used`: keep it live another hour, unless it was stopped or replaced since. */
	touch(used: ActiveSource) {
		const a = liveSource(read(), Date.now());
		if (sameSource(a, used)) write({ ...used, at: Date.now() });
		else stored = a;
	},
	/** Load it and follow other tabs; returns the cleanup. Call from onMount. */
	init(): () => void {
		if (typeof window === 'undefined') return () => {};
		stored = read();
		now = Date.now();
		const tick = setInterval(() => (now = Date.now()), 60_000);
		const onStorage = (e: StorageEvent) => {
			if (e.key === KEY || e.key === null) stored = read();
		};
		window.addEventListener('storage', onStorage);
		return () => {
			clearInterval(tick);
			window.removeEventListener('storage', onStorage);
		};
	}
};
