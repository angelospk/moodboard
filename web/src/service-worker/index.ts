// Keeps the app's own code (the hashed files of this build) in the browser, so a repeat visit does not
// ask GitHub Pages for each file again (Pages allows only 10 minutes of caching). Pages (HTML), the API
// and images are not touched here: the HTML always comes from the network, so a new deploy shows at once.
import { self as sw } from '$app/service-worker';
import { immutable } from '$app/manifest';
// Paths are relative to the base path (here the site root).
const build = immutable.map((f) => '/' + f.path.replace(/^\//, ''));
const ASSETS = new Set(build);
// One cache per build, named by its file list ($app/env's version is not set inside a service worker).
let h = 0;
for (const c of build.join('|')) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
const CACHE = `mb-app-${(h >>> 0).toString(36)}`;

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((c) => c.addAll(build))
			.then(() => sw.skipWaiting())
	);
});

sw.addEventListener('activate', (event) => {
	// Drop the code of older builds.
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k.startsWith('mb-app-') && k !== CACHE).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim())
	);
});

sw.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== sw.location.origin || !ASSETS.has(url.pathname)) return;
	event.respondWith(
		caches.open(CACHE).then(async (c) => (await c.match(url.pathname)) ?? fetch(req))
	);
});
