import { redirect } from '@sveltejs/kit';
import { pb } from '#lib/pb.js';
import { listLevels } from '#lib/levels.js';
import { setLevels } from '#lib/levels.svelte.js';
import type { LayoutLoad } from './$types';

// A static SPA: every load runs in the browser, where the PocketBase client and its auth store live.
export const ssr = false;
export const prerender = false;

/** The user whose levels are in the shared store, so a navigation does not fetch them again. */
let levelsFor: string | null = null;

export const load: LayoutLoad = async ({ url, depends }) => {
	depends('app:auth');
	// /s/<project id>: a public, read-only board. It never uses the visitor's session, so do not touch it.
	if (url.pathname.startsWith('/s/')) return { pb, user: null };
	let user = pb.authStore.record;

	if (user) {
		// Verify the stored token once per page load; an expired or revoked one signs the user out.
		try {
			await pb.collection('users').authRefresh();
			user = pb.authStore.record;
		} catch (e) {
			if ((e as { status?: number }).status === 401) {
				pb.authStore.clear();
				user = null;
			}
		}
	}

	if (!user && url.pathname !== '/login') {
		redirect(307, '/login?next=' + encodeURIComponent(url.pathname + url.search));
	}

	// The levels are small and every page shows them: load them once per signed-in user.
	if (!user) {
		levelsFor = null;
		setLevels([]);
	} else if (levelsFor !== user.id) {
		// Only a successful fetch counts as loaded, so a failed one is tried again on the next page.
		try {
			setLevels(await listLevels(pb));
			levelsFor = user.id;
		} catch {
			/* keep what is shown */
		}
	}

	return { pb, user };
};
