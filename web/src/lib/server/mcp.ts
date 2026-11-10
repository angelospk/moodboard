import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { LEVELS } from '#lib/types.js';
import { addNote, getInspiration, listProjects, saveInspiration, searchInspirations } from './tools';

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });
const level = z.enum(LEVELS).describe('Scale of the inspiration: urban, building, interior, detail or material');

/** One MCP server per request, bound to the caller's own Supabase client (RLS = authorization). */
export function buildMcpServer(sb: SupabaseClient, userId: string) {
	const server = new McpServer({ name: 'moodboard', version: '0.1.0' });
	const ro = { readOnlyHint: true, openWorldHint: false };

	server.registerTool(
		'list_projects',
		{ title: 'List projects', description: 'List the user\'s moodboard projects with how many inspirations each has.', inputSchema: {}, annotations: ro },
		async () => json(await listProjects(sb))
	);

	server.registerTool(
		'search_inspirations',
		{
			title: 'Search inspirations',
			description:
				'Search saved inspirations (images with notes, tags, level and marked details). Newest first. Use get_inspiration to see one image.',
			inputSchema: {
				query: z.string().optional().describe('Words to find in the note or source title'),
				project: z.string().optional().describe('Project name or id'),
				tags: z.array(z.string()).optional().describe('All of these tags must be present'),
				level: level.optional(),
				limit: z.number().int().min(1).max(100).optional()
			},
			annotations: ro
		},
		async (args) => json(await searchInspirations(sb, args))
	);

	server.registerTool(
		'get_inspiration',
		{
			title: 'Get inspiration',
			description:
				'Get one inspiration with its image, note and marked regions. Regions are rectangles in fractions (0..1) of the image with the user\'s note on what they like there.',
			inputSchema: { id: z.string().uuid() },
			annotations: ro
		},
		async ({ id }) => {
			const r = await getInspiration(sb, id);
			const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [
				{ type: 'text', text: JSON.stringify({ ...r.inspiration, image_url: r.image_url }, null, 2) }
			];
			if (r.image) content.push({ type: 'image', ...r.image });
			return { content };
		}
	);

	server.registerTool(
		'save_inspiration',
		{
			title: 'Save inspiration',
			description:
				'Save a public https image to the moodboard, optionally in a project (created if missing) with a note, tags and level.',
			inputSchema: {
				image_url: z.string().url(),
				project: z.string().optional(),
				note: z.string().max(5000).optional(),
				tags: z.array(z.string().max(40)).max(30).optional(),
				level: level.optional(),
				source_url: z.string().url().optional(),
				source_title: z.string().max(300).optional()
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
		},
		async (args) => json(await saveInspiration(sb, userId, args))
	);

	server.registerTool(
		'add_note',
		{
			title: 'Add note',
			description: 'Append a thought to an inspiration\'s note. Existing text is kept.',
			inputSchema: { id: z.string().uuid(), text: z.string().min(1).max(5000) },
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
		},
		async ({ id, text }) => json(await addNote(sb, id, text))
	);

	return server;
}
