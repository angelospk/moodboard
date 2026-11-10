import { json } from '@sveltejs/kit';
import { APP_URL } from '$app/env/private';
import { PUBLIC_SUPABASE_URL } from '$app/env/public';
import type { RequestHandler } from './$types';

// RFC 9728 protected resource metadata for the MCP endpoint. Served at both
// /.well-known/oauth-protected-resource and /.well-known/oauth-protected-resource/mcp.
export const GET: RequestHandler = () =>
	json(
		{
			resource: `${APP_URL}/mcp`,
			resource_name: 'Moodboard',
			authorization_servers: [`${PUBLIC_SUPABASE_URL}/auth/v1`],
			bearer_methods_supported: ['header']
		},
		{ headers: { 'access-control-allow-origin': '*', 'cache-control': 'max-age=300' } }
	);
