import { redirect } from '@sveltejs/kit';
import { pb } from '#lib/pb.js';
import type { LayoutLoad } from './$types';

// A static SPA: every load runs in the browser, where the PocketBase client and its auth store live.
export const ssr = false;
export const prerender = false;

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

	return { pb, user };
};
