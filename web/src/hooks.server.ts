import { createServerClient } from '@supabase/ssr';
import { redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { PUBLIC_SUPABASE_KEY, PUBLIC_SUPABASE_URL } from '$app/env/public';

const PUBLIC_PATHS = ['/login', '/mcp', '/.well-known'];

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.supabase = createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_KEY, {
		cookies: {
			getAll: () => event.cookies.getAll(),
			setAll: (cookiesToSet, headers) => {
				for (const { name, value, options } of cookiesToSet)
					event.cookies.set(name, value, { ...options, path: '/' });
				if (headers) event.setHeaders(headers);
			}
		}
	});

	// getSession() alone trusts the cookie; getUser() verifies the JWT with the auth server.
	event.locals.safeGetSession = async () => {
		const { data: { session } } = await event.locals.supabase.auth.getSession();
		if (!session) return { session: null, user: null };
		const { data: { user }, error } = await event.locals.supabase.auth.getUser();
		if (error || !user) return { session: null, user: null };
		return { session, user };
	};

	const path = event.url.pathname;
	if (!PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) {
		const { user } = await event.locals.safeGetSession();
		if (!user) redirect(303, `/login?next=${encodeURIComponent(path + event.url.search)}`);
	}

	const response = await resolve(event, {
		filterSerializedResponseHeaders: (name) => name === 'content-range' || name === 'x-supabase-api-version'
	});
	// No framing anywhere: protects the OAuth consent page from clickjacking.
	if (!response.headers.has('x-frame-options')) response.headers.set('x-frame-options', 'DENY');
	return response;
};
