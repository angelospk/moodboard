import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { RequestHandler } from './$types';
import { buildMcpServer } from '#lib/server/mcp.js';
import { clientForToken } from '#lib/server/supabase.js';
import { APP_URL } from '$app/env/private';

const unauthorized = () =>
	new Response(JSON.stringify({ error: 'unauthorized' }), {
		status: 401,
		headers: {
			'content-type': 'application/json',
			// RFC 9728: tells MCP clients where to start OAuth discovery.
			'www-authenticate': `Bearer resource_metadata="${APP_URL}/.well-known/oauth-protected-resource/mcp"`
		}
	});

/** Read the client_id claim. Call only after Supabase verified the token (getUser). */
function hasClientId(jwt: string): boolean {
	try {
		const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
		return typeof payload.client_id === 'string' && payload.client_id.length > 0;
	} catch {
		return false;
	}
}

const handle: RequestHandler = async ({ request }) => {
	const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
	if (!token) return unauthorized();
	const auth = await clientForToken(token);
	// Only tokens from the OAuth flow (they carry client_id) may call MCP; a web session token may not.
	if (auth && !hasClientId(token)) return unauthorized();
	if (!auth) return unauthorized();

	// Stateless: a fresh server + transport per request, JSON responses, no sessions.
	const server = buildMcpServer(auth.sb, auth.userId);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true
	});
	await server.connect(transport);
	return transport.handleRequest(request);
};

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
