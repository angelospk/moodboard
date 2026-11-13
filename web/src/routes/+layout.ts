import { redirect } from '@sveltejs/kit';
import { pb } from '#lib/pb.js';
import { listLevels } from '#lib/levels.js';
import { levelStore, setLevels } from '#lib/levels.svelte.js';
import type { RecordModel } from 'pocketbase';
import type { LayoutLoad } from './$types';

// A static SPA: every load runs in the browser, where the PocketBase client and its auth store live.
export const ssr = false;
export const prerender = false;

/** The user whose levels are in the shared store (or are on their way), so a navigation does not fetch them again. */
let levelsFor: string | null = null;
/** The stored token is checked with the server once per page load, not on every navigation. */
let verified = false;

export const load: LayoutLoad = async ({ url, depends }) => {
	depends('app:auth');
	// /s/<project id>: a public, read-only board. It never uses the visitor's session, so do not touch it.
	if (url.pathname.startsWith('/s/')) return { pb, user: null };

	// An expired token cannot work: drop it now. A token that has not expired is used at once, and the
	// server check runs alongside the page's own requests: each round trip to the server can take
	// seconds, and the page must not wait for this one. A revoked token (401) signs the user out; the
	// root layout then re-runs this load, which sends them to /login.
	if (pb.authStore.record && !pb.authStore.isValid) pb.authStore.clear();
	if (pb.authStore.record && !verified) {
		verified = true;
		const token = pb.authStore.token;
		// pb.send, not authRefresh(): the answer is applied only to the session it checked, so a late
		// answer cannot bring back a session the user left, or end one they started meanwhile.
		pb.send<{ token: string; record: RecordModel }>('/api/collections/users/auth-refresh', {
			method: 'POST',
			headers: { Authorization: token }
		})
			.then((r) => {
				if (pb.authStore.token === token) pb.authStore.save(r.token, r.record);
			})
			.catch((e) => {
				if (pb.authStore.token !== token) return;
				if ((e as { status?: number }).status === 401) pb.authStore.clear();
				else verified = false;
			});
	}
	const user = pb.authStore.record;

	if (!user && url.pathname !== '/login') {
		redirect(307, '/login?next=' + encodeURIComponent(url.pathname + url.search));
	}

	// The levels are small and every page shows them: load them once per signed-in user, without
	// holding the page back (the store is reactive, so the names show up when they arrive).
	if (!user) {
		levelsFor = null;
		setLevels([]);
	} else if (levelsFor !== user.id) {
		const id = user.id;
		// Another account's levels must not show while this one's load.
		setLevels([]);
		levelsFor = id;
		const before = levelStore.list;
		listLevels(pb)
			.then((rows) => {
				// A change made meanwhile (the level manager) is newer than this answer: keep it.
				if (levelsFor === id && levelStore.list === before) setLevels(rows);
			})
			.catch(() => {
				// Only a successful fetch counts as loaded, so a failed one is tried again on the next page.
				if (levelsFor === id) levelsFor = null;
			});
	}

	return { pb, user };
};
