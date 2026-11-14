// «Προσθέτεις από», per browser: the map and /new share it, and other tabs follow it.
import { cleanSourceProject } from '#lib/sourceProjects.js';
import { liveSource, parseActiveSource, type ActiveSource } from '#lib/activeSource.js';

const KEY = 'moodboard:active-source';

let stored = $state<ActiveSource | null>(null);
/** Re-read once a minute so a source that lapses leaves the screen. */
let now = $state(Date.now());

function read(): ActiveSource | null {
	try {
		return parseActiveSource(localStorage.getItem(KEY));
	} catch {
		return null;
	}
}

function write(a: ActiveSource | null) {
	stored = a;
	try {
		if (a) localStorage.setItem(KEY, JSON.stringify(a));
		else localStorage.removeItem(KEY);
	} catch {
		// Private mode or blocked storage: the source lasts until the page closes.
	}
}

export const activeSource = {
	/** The live source (shown on screen), or null. */
	get live(): ActiveSource | null {
		return liveSource(stored, now);
	},
	/** The live source at this moment (for a new image), or null. */
	fresh(): ActiveSource | null {
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
	/** An image was added with it: keep it live for another hour. */
	touch() {
		const a = liveSource(stored, Date.now());
		if (a) write({ ...a, at: Date.now() });
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
